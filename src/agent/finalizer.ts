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
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '[TOKEN_REDACTED]');
}

/**
 * Prepare final message for Telegram.
 */
export function splitForTelegram(text: string): string[] {
  const sanitized = sanitizeOutput(text);
  if (sanitized.length <= MAX_TELEGRAM_LENGTH) return [sanitized];

  const chunks: string[] = [];
  let remaining = sanitized;

  while (remaining.length > MAX_TELEGRAM_LENGTH) {
    const slice = remaining.slice(0, MAX_TELEGRAM_LENGTH);
    let cut = slice.lastIndexOf('\n');
    if (cut < Math.floor(MAX_TELEGRAM_LENGTH * 0.6)) {
      const space = slice.lastIndexOf(' ');
      if (space > Math.floor(MAX_TELEGRAM_LENGTH * 0.6)) {
        cut = space;
      } else {
        cut = -1;
      }
    }
    if (cut === -1) cut = MAX_TELEGRAM_LENGTH;

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

  return chunks;
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
