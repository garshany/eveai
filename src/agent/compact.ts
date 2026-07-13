import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { isTurnAborted } from './activity.js';
import { runModelText } from './model.js';

type MessageRow = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
};

export type SummarizerFn = (input: {
  existingSummary: string | null;
  messages: MessageRow[];
}) => Promise<string>;

const MAX_SUMMARY_CHARS = 4000;

/**
 * Max tokens of recent user messages to preserve in compacted history.
 * Mirrors Codex COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000.
 */
const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

/** Max retries when summarizer fails (Codex-style retry on transient errors). */
const COMPACT_MAX_RETRIES = 2;

/**
 * Rough token estimate for a soft budget (the keep window), not a hard overflow
 * guard — the mid-turn trigger uses the API's exact usage for that. UTF-8 bytes/4
 * is a dependency-free BPE proxy: ASCII is ~1 byte/char (so ≈ chars/4 as before),
 * while Cyrillic is ~2 bytes/char, so Russian text counts ~2x higher — much closer
 * to modern GPT-5-family tokenization than a flat chars/4, which underclaimed Cyrillic and
 * silently kept ~2x too much recent history for the default Russian output.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/**
 * Trim `text` to at most `max` chars, preferring the last line break within the
 * cap so a bulleted summary is never cut in the middle of a bullet. Falls back to
 * a hard cut only if there is no reasonable line boundary (a single huge line).
 */
export function capOnLineBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const hard = text.slice(0, max);
  const nl = hard.lastIndexOf('\n');
  return nl > max * 0.5 ? hard.slice(0, nl) : hard;
}

// Codex-style compaction prompt — adapted for EVE Online assistant
const COMPACTION_DEVELOPER_PROMPT = `Ты выполняешь СЖАТИЕ КОНТЕКСТА. Создай краткую передачу для другой языковой модели, которая продолжит диалог.

Обязательно сохрани:
- Имена персонажей, систем, предметов, корпораций и их ID
- Текущую локацию пользователя, корабль, регион
- Ключевые данные: цены, маршруты, kills, ассеты, скиллы (числа!)
- Предпочтения пользователя и стиль общения
- Что уже сделано и какие данные получены (чтобы не вызывать tools повторно)
- Открытые вопросы или незавершённые задачи

Формат — краткий, структурированный. Не выдумывай.
Максимум 12-15 пунктов.`;

// Prefix injected before the summary when loading into cold context
export const SUMMARY_PREFIX = 'Другая языковая модель начала решать эту задачу и создала сводку своего процесса. Используй эту информацию, чтобы продолжить работу и не дублировать уже сделанное. Вот сводка:\n\n';

// ---------------------------------------------------------------------------
// Codex-style: dynamic auto-compact limit
// ---------------------------------------------------------------------------

/**
 * Compute the auto-compaction token limit.
 * Codex approach: 90% of model context window, or explicit override.
 *
 * ```rust
 * let context_limit = context_window.map(|cw| (cw * 9) / 10);
 * let config_limit = model.auto_compact_token_limit;
 * return min(config_limit, context_limit)
 * ```
 */
export function autoCompactLimit(): number {
  const contextLimit = Math.floor(config.openai.modelContextWindow * 0.9);
  const override = config.openai.compactThreshold;
  if (override > 0) return Math.min(override, contextLimit);
  return contextLimit;
}

// ---------------------------------------------------------------------------
// DB accessors
// ---------------------------------------------------------------------------

export function getThreadSummary(db: Db, threadId: string): string | null {
  const row = db.prepare('SELECT summary FROM thread_summaries WHERE thread_id = ?').get(threadId) as
    | { summary: string }
    | undefined;
  return row?.summary ?? null;
}

export function getThreadTotalTokens(db: Db, threadId: string): number {
  const row = db.prepare('SELECT total_tokens FROM agent_threads WHERE thread_id = ?').get(threadId) as
    | { total_tokens: number | null }
    | undefined;
  return row?.total_tokens ?? 0;
}

// ---------------------------------------------------------------------------
// Codex-style: pre-turn compaction check
// ---------------------------------------------------------------------------

/**
 * Check if pre-turn compaction is needed.
 * Codex `run_pre_sampling_compact`: before the first API call of a turn,
 * if accumulated total_tokens >= autoCompactLimit, compact now.
 */
export function needsPreTurnCompaction(db: Db, threadId: string): boolean {
  return getThreadTotalTokens(db, threadId) >= autoCompactLimit();
}

/**
 * Run pre-turn compaction (Codex `run_pre_sampling_compact`).
 * Called before the response loop starts. Returns true if compaction ran.
 */
export async function runPreTurnCompact(
  db: Db,
  threadId: string,
  summarizer: SummarizerFn = defaultSummarizer,
): Promise<boolean> {
  if (!needsPreTurnCompaction(db, threadId)) return false;
  console.log('[compact] pre-turn: total_tokens=%d >= limit=%d, compacting',
    getThreadTotalTokens(db, threadId), autoCompactLimit());
  return compactThreadWithRetry(db, threadId, summarizer);
}

// ---------------------------------------------------------------------------
// Codex-style: mid-turn compaction check
// ---------------------------------------------------------------------------

/**
 * Check if mid-turn compaction should run.
 * Codex: after each sampling request, if total_usage_tokens >= autoCompactLimit
 * AND model needs a follow-up (tool call), compact and continue.
 */
export function needsMidTurnCompaction(inputTokens: number): boolean {
  return inputTokens >= autoCompactLimit();
}

/**
 * Run mid-turn compaction (Codex `run_inline_auto_compact_task`).
 * Called inside the response loop when input tokens exceed the limit.
 * Returns true if compaction ran successfully.
 */
export async function runMidTurnCompact(
  db: Db,
  threadId: string,
  summarizer: SummarizerFn = defaultSummarizer,
): Promise<boolean> {
  console.log('[compact] mid-turn: compacting thread=%s', threadId.slice(0, 12));
  return compactThreadWithRetry(db, threadId, summarizer);
}

// ---------------------------------------------------------------------------
// Core compaction with retry (Codex `run_compact_task_inner`)
// ---------------------------------------------------------------------------

/**
 * Compact thread with retry on summarizer failure.
 * Codex approach: on transient error, retry up to COMPACT_MAX_RETRIES times.
 * On ContextWindowExceeded-like failure, could remove oldest messages and retry
 * (simplified: we retry the summarizer since our summarizer is a separate call).
 */
export async function compactThreadWithRetry(
  db: Db,
  threadId: string,
  summarizer: SummarizerFn = defaultSummarizer,
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= COMPACT_MAX_RETRIES; attempt++) {
    // Ctrl-C during a failing summarizer: an abandoned turn must not keep
    // issuing compaction model calls (or block the input queue on backoff).
    if (isTurnAborted()) return false;
    try {
      return await compactThread(db, threadId, summarizer);
    } catch (error) {
      lastError = error;
      console.warn('[compact] attempt %d/%d failed: %s',
        attempt + 1, COMPACT_MAX_RETRIES + 1, error instanceof Error ? error.message : String(error));
      if (attempt < COMPACT_MAX_RETRIES) {
        // Brief pause before retry (Codex-style backoff)
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  console.error('[compact] all %d attempts failed for thread=%s', COMPACT_MAX_RETRIES + 1, threadId.slice(0, 12));
  throw lastError;
}

// ---------------------------------------------------------------------------
// Core compaction logic (Codex `build_compacted_history_with_limit`)
// ---------------------------------------------------------------------------

export async function compactThread(
  db: Db,
  threadId: string,
  summarizer: SummarizerFn = defaultSummarizer,
): Promise<boolean> {
  const allMessages = db.prepare(
    "SELECT id, role, content FROM messages WHERE thread_id = ? AND role IN ('user','assistant') ORDER BY id ASC"
  ).all(threadId) as MessageRow[];

  if (allMessages.length <= 2) return false;

  const existingSummaryRow = db.prepare(
    'SELECT summary, last_message_id FROM thread_summaries WHERE thread_id = ?'
  ).get(threadId) as { summary: string; last_message_id: number } | undefined;

  // Codex-style: backward selection of recent messages to preserve
  // COMPACT_USER_MESSAGE_MAX_TOKENS budget
  const keepMessages: MessageRow[] = [];
  let keepTokens = 0;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    const tokens = estimateTokens(msg.content);
    if (keepMessages.length > 0 && keepTokens + tokens > COMPACT_USER_MESSAGE_MAX_TOKENS) break;
    keepMessages.unshift(msg);
    keepTokens += tokens;
  }

  // Messages to summarize = everything before the kept messages
  const keepMinId = keepMessages[0]?.id ?? Number.MAX_SAFE_INTEGER;
  const startId = existingSummaryRow?.last_message_id ?? 0;
  const allCandidates = allMessages.filter((msg) => msg.id > startId && msg.id < keepMinId);
  if (allCandidates.length === 0) {
    // Nothing to summarize, but reset token counter to stop re-triggering and
    // prune stale tool audit rows that fell out of the keep window.
    db.prepare("DELETE FROM messages WHERE thread_id = ? AND role = 'tool' AND id < ?").run(threadId, keepMinId);
    db.prepare('UPDATE agent_threads SET total_tokens = 0 WHERE thread_id = ?').run(threadId);
    return false;
  }

  // Only summarize (and later delete) what actually fits the summarizer input
  // budget — anything beyond the cap stays for the next compaction pass instead
  // of being deleted unsummarized. Uses the same per-line accounting as
  // buildTranscript so the transcript never drops a selected candidate.
  const candidates: MessageRow[] = [];
  let candidateChars = 0;
  for (const msg of allCandidates) {
    const cost = transcriptLineLength(msg);
    if (candidates.length > 0 && candidateChars + cost > config.compact.maxInputChars) break;
    candidates.push(msg);
    candidateChars += cost;
  }
  if (candidates.length < allCandidates.length) {
    console.log('[compact] thread=%s input budget reached: summarizing %d/%d candidates this pass',
      threadId.slice(0, 12), candidates.length, allCandidates.length);
  }

  const lastSummarizedId = candidates[candidates.length - 1].id;
  const summaryText = (await summarizer({
    existingSummary: existingSummaryRow?.summary ?? null,
    messages: candidates,
  })).trim();

  if (!summaryText) return false;

  // Ctrl-C landed while the summarizer was in flight: don't rewrite history
  // (summary upsert + message pruning) for a turn the user already abandoned.
  // The backlog stays over the limit, so the next turn simply compacts again.
  if (isTurnAborted()) return false;

  // Cap the summary, but cut on a line (bullet) boundary rather than mid-bullet:
  // a half-truncated fact is worse than dropping it, and the capped summary is
  // fed back as existingSummary on the next pass, so a broken tail would compound.
  const cappedSummary = capOnLineBoundary(summaryText, MAX_SUMMARY_CHARS);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO thread_summaries (thread_id, summary, last_message_id, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(thread_id) DO UPDATE SET summary = excluded.summary, last_message_id = excluded.last_message_id, updated_at = excluded.updated_at`
    ).run(threadId, cappedSummary, lastSummarizedId);

    // Delete compacted user+assistant messages
    db.prepare('DELETE FROM messages WHERE thread_id = ? AND id <= ?').run(threadId, lastSummarizedId);

    // Clean up tool messages outside keep window
    db.prepare("DELETE FROM messages WHERE thread_id = ? AND role = 'tool' AND id < ?").run(threadId, keepMinId);

    // Reset cumulative token counter (compaction = fresh start)
    db.prepare('UPDATE agent_threads SET total_tokens = 0 WHERE thread_id = ?').run(threadId);

    // Clear last_response_id to force cold start with new context
    db.prepare("UPDATE agent_threads SET last_response_id = NULL, updated_at = datetime('now') WHERE thread_id = ?").run(threadId);
  });
  tx();

  console.log('[compact] thread=%s summarized %d messages, kept %d, summary=%d chars, tokens reset',
    threadId.slice(0, 12), candidates.length, keepMessages.length, cappedSummary.length);
  return true;
}

// ---------------------------------------------------------------------------
// Default summarizer
// ---------------------------------------------------------------------------

async function defaultSummarizer(input: {
  existingSummary: string | null;
  messages: MessageRow[];
}): Promise<string> {
  const transcript = buildTranscript(input.messages, config.compact.maxInputChars);
  if (!transcript) return '';

  const userText = [
    input.existingSummary ? `Previous summary:\n${input.existingSummary}\n` : '',
    'New messages to summarize:',
    transcript,
  ].filter(Boolean).join('\n\n');

  return await runModelText(COMPACTION_DEVELOPER_PROMPT, userText);
}

function transcriptPrefix(msg: MessageRow): string {
  return msg.role === 'user' ? 'User: ' : 'Assistant: ';
}

/** Cost of one message in the transcript: prefix + content + joining newline. */
function transcriptLineLength(msg: MessageRow): number {
  return transcriptPrefix(msg).length + msg.content.length + 1;
}

function buildTranscript(messages: MessageRow[], maxChars: number): string {
  const lines: string[] = [];
  let total = 0;
  for (const msg of messages) {
    const line = `${transcriptPrefix(msg)}${msg.content}`;
    if (lines.length > 0 && total + line.length + 1 > maxChars) break;
    // Always include at least one (possibly truncated) message so compaction
    // makes progress even on a single oversized message.
    lines.push(line.length > maxChars ? line.slice(0, maxChars) : line);
    total += Math.min(line.length, maxChars) + 1;
  }
  return lines.join('\n');
}
