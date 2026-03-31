import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
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

/** Compaction token threshold — when cumulative thread tokens exceed this, compact. */
const COMPACT_TOKEN_THRESHOLD = 100_000;

export function getThreadSummary(db: Db, threadId: string): string | null {
  const row = db.prepare('SELECT summary FROM thread_summaries WHERE thread_id = ?').get(threadId) as
    | { summary: string }
    | undefined;
  return row?.summary ?? null;
}

/** Get cumulative token count for a thread. */
export function getThreadTotalTokens(db: Db, threadId: string): number {
  const row = db.prepare('SELECT total_tokens FROM agent_threads WHERE thread_id = ?').get(threadId) as
    | { total_tokens: number | null }
    | undefined;
  return row?.total_tokens ?? 0;
}

/** Check if compaction is needed based on cumulative token usage. */
export function needsCompaction(db: Db, threadId: string): boolean {
  return getThreadTotalTokens(db, threadId) >= COMPACT_TOKEN_THRESHOLD;
}

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

  // Keep recent messages by token budget (codex-style backward selection)
  const keepTokenBudget = 20_000; // ~20K tokens of recent messages
  const keepMessages: MessageRow[] = [];
  let keepTokens = 0;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    const tokens = Math.ceil(msg.content.length / 4);
    if (keepMessages.length > 0 && keepTokens + tokens > keepTokenBudget) break;
    keepMessages.unshift(msg);
    keepTokens += tokens;
  }

  // Messages to summarize = everything before the kept messages
  const keepMinId = keepMessages[0]?.id ?? Number.MAX_SAFE_INTEGER;
  const startId = existingSummaryRow?.last_message_id ?? 0;
  const candidates = allMessages.filter((msg) => msg.id > startId && msg.id < keepMinId);
  if (candidates.length === 0) {
    // Nothing to summarize, but reset token counter to stop re-triggering
    db.prepare('UPDATE agent_threads SET total_tokens = 0 WHERE thread_id = ?').run(threadId);
    return false;
  }

  const lastSummarizedId = candidates[candidates.length - 1].id;
  const summaryText = (await summarizer({
    existingSummary: existingSummaryRow?.summary ?? null,
    messages: candidates,
  })).trim();

  if (!summaryText) return false;

  const cappedSummary = summaryText.length > MAX_SUMMARY_CHARS
    ? summaryText.slice(0, MAX_SUMMARY_CHARS)
    : summaryText;

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

// Legacy compat — called from handlers.ts background
export async function compactThreadIfNeeded(
  db: Db,
  threadId: string,
  summarizer: SummarizerFn = defaultSummarizer,
): Promise<boolean> {
  if (!needsCompaction(db, threadId)) return false;
  return compactThread(db, threadId, summarizer);
}

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

function buildTranscript(messages: MessageRow[], maxChars: number): string {
  const lines: string[] = [];
  let total = 0;
  for (const msg of messages) {
    const prefix = msg.role === 'user' ? 'User: ' : 'Assistant: ';
    const line = `${prefix}${msg.content}`;
    if (total + line.length > maxChars) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join('\n');
}
