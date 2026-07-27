/**
 * Finalizer utilities.
 * Post-processes agent output before sending to Telegram.
 */
import type { Db } from '../db/sqlite.js';
import { pickTelegramParseMode } from '../telegram/formatting.js';

const MAX_TELEGRAM_LENGTH = 4096;

/**
 * Truncate text to Telegram's message limit and add a notice if truncated.
 */
export function truncateForTelegram(text: string): string {
  if (text.length <= MAX_TELEGRAM_LENGTH) return text;
  const cutoff = MAX_TELEGRAM_LENGTH - 30;
  return text.slice(0, cutoff) + '\n\n[...ответ обрезан]';
}

/**
 * Strip any accidentally leaked tokens or secrets from the response.
 */
export function sanitizeOutput(text: string): string {
  return text
    // Bearer tokens, including standard-base64 chars (+ / =).
    .replace(/Bearer\s+[A-Za-z0-9._+/=-]{20,}/g, 'Bearer [REDACTED]')
    // JWTs (access tokens), signature may contain / and +.
    .replace(/eyJ[A-Za-z0-9._+/=-]{20,}/g, '[TOKEN_REDACTED]');
}

const FENCE = '```';
/** Room for a closing fence on one chunk plus a reopening fence on the next. */
const FENCE_RESERVE = 8;

/**
 * Prepare final message for Telegram.
 * Pass a smaller `limit` when a prefix will be prepended to each chunk —
 * Telegram hard-rejects payloads over 4096 chars.
 *
 * Each chunk is formatted independently downstream, so a split that lands
 * inside a ``` block must not leave the fence unbalanced: the chunk would
 * render as code to its end while the next chunk would read the real closing
 * fence as an opening one, swallowing its trailing text and wrapping the
 * following prose in <pre>. Chunks are rebalanced so every one is
 * self-contained.
 */
export function splitForTelegram(text: string, limit: number = MAX_TELEGRAM_LENGTH): string[] {
  const sanitized = sanitizeOutput(text);
  if (sanitized.length <= limit) return [sanitized];

  const hasFence = sanitized.includes(FENCE);
  // Only fenced text pays the reserve, so plain messages chunk exactly as before.
  const effectiveLimit = hasFence ? Math.max(1, limit - FENCE_RESERVE) : limit;

  const chunks: string[] = [];
  let remaining = sanitized;

  while (remaining.length > effectiveLimit) {
    const slice = remaining.slice(0, effectiveLimit);
    let cut = slice.lastIndexOf('\n');
    if (cut < Math.floor(effectiveLimit * 0.6)) {
      const space = slice.lastIndexOf(' ');
      if (space > Math.floor(effectiveLimit * 0.6)) {
        cut = space;
      } else {
        cut = -1;
      }
    }
    if (cut === -1) cut = effectiveLimit;
    if (hasFence) {
      cut = avoidBacktickSplit(remaining, cut);
      cut = avoidSplitAfterOpeningFence(remaining, cut);
    }

    chunks.push(remaining.slice(0, cut));
    let nextStart = cut;
    while (nextStart < remaining.length && (remaining[nextStart] === '\n' || remaining[nextStart] === ' ')) {
      nextStart += 1;
    }
    remaining = remaining.slice(nextStart);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return hasFence ? rebalanceFences(chunks) : chunks;
}

/**
 * Move a cut off a run of backticks.
 *
 * A hard cut at the limit can land in the middle of a ``` delimiter, leaving
 * "``" on one chunk and "`" on the next. Neither fragment reads as a fence, so
 * rebalanceFences would wrap the wrong side and leak stray backticks. Cutting
 * before the whole run keeps every delimiter intact. If the run starts at the
 * chunk boundary itself there is nothing to gain, so the original cut stands.
 */
function avoidBacktickSplit(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  if (text[cut] !== '`' && text[cut - 1] !== '`') return cut;

  let start = cut;
  while (start > 0 && text[start - 1] === '`') start -= 1;
  return start > 0 ? start : cut;
}

/**
 * Keep an opening fence together with the newline that makes it one.
 *
 * Cutting at the newline right after "```ts" strands the marker at the end of
 * the chunk: a block opens on ``` plus a newline, so without it the chunk reads
 * as closed, the code that follows is sent as prose, and the real closing fence
 * becomes an opener that swallows the trailing text. A closing marker is left
 * alone — it legitimately ends the chunk, and moving it would emit an empty
 * <pre> on the next one.
 */
function avoidSplitAfterOpeningFence(text: string, cut: number): number {
  const head = text.slice(0, cut);
  const lastNewline = head.lastIndexOf('\n');
  const lastLine = head.slice(lastNewline + 1);
  if (!/^```[^`]*$/.test(lastLine)) return cut;
  // Whatever precedes decides which kind of marker this is.
  if (endsInsideFence(head.slice(0, Math.max(0, lastNewline)))) return cut;
  return lastNewline > 0 ? lastNewline : cut;
}

/**
 * Close a fence left open at the end of a chunk and reopen it on the next one,
 * so each chunk parses on its own. The reopened fence carries no language tag —
 * the formatter drops it anyway.
 */
function rebalanceFences(chunks: string[]): string[] {
  const balanced: string[] = [];
  let insideFence = false;

  for (const raw of chunks) {
    let chunk: string = insideFence ? `${FENCE}\n${raw}` : raw;
    insideFence = endsInsideFence(chunk);
    if (insideFence) chunk = `${chunk}\n${FENCE}`;
    balanced.push(chunk);
  }

  return balanced;
}

/**
 * True when the chunk ends inside an unterminated code block, using the same
 * syntax the formatter applies: a block opens on ``` plus an optional language
 * tag AND a newline. Counting raw ``` runs instead would treat a same-line span
 * ("до ```code``` после") split across chunks as an open block, and closing it
 * makes the formatter read the rest of the line as a language tag — deleting
 * that text from the answer.
 */
function endsInsideFence(chunk: string): boolean {
  const blocks = /(^|\n)```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
  let open = false;
  let match: RegExpExecArray | null;

  while ((match = blocks.exec(chunk)) !== null) {
    open = !chunk.slice(match.index, blocks.lastIndex).endsWith(FENCE);
    if (match[0].length === 0) break; // defensive: never spin on an empty match
  }

  return open;
}

export function finalizeMessage(text: string): string {
  return sanitizeOutput(text);
}

export function finalizeThreadMessage(db: Db, threadId: string, text: string): string {
  const sanitized = finalizeMessage(text);
  const block = buildHelpfulCommandsBlock(db, threadId, sanitized);
  return block ? `${sanitized}\n\n${block}` : sanitized;
}

function buildHelpfulCommandsBlock(db: Db, threadId: string, text: string): string | null {
  const rows = db.prepare(
    "SELECT content FROM messages WHERE thread_id = ? AND role = 'tool' ORDER BY id DESC LIMIT 8"
  ).all(threadId) as Array<{ content: string }>;
  if (rows.length === 0) return null;

  const commands = new Set<string>();
  for (const row of rows) {
    try {
      collectCommands(JSON.parse(row.content), commands);
    } catch {
      continue;
    }
  }

  const filtered = [...commands]
    .filter((command) => !text.includes(command))
    .sort((left, right) => {
      const leftKind = left.startsWith('/market') ? 0 : 1;
      const rightKind = right.startsWith('/market') ? 0 : 1;
      return leftKind - rightKind || left.localeCompare(right);
    })
    .slice(0, 8);

  if (filtered.length === 0) return null;
  if (pickTelegramParseMode(text) === 'HTML') {
    return `<b>Полезные команды</b>\n${filtered.map((command) => `• <code>${escapeHtml(command)}</code>`).join('\n')}`;
  }
  return `**Полезные команды**\n${filtered.map((command) => `- \`${command}\``).join('\n')}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function collectCommands(value: unknown, commands: Set<string>): void {
  if (!value) return;
  if (typeof value === 'string') {
    const matches = value.match(/\/(?:market|info)\s+\d+/g) ?? [];
    for (const match of matches) {
      commands.add(match.trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCommands(item, commands);
    return;
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectCommands(entry, commands);
    }
  }
}
