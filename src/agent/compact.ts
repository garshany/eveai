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

const MAX_SUMMARY_CHARS = 2000;

const SUMMARY_DEVELOPER_PROMPT = `Ты сжимаешь историю диалога в краткую структурированную память.

Формат:
Facts:
- ...
Preferences:
- ...
Active tasks:
- ...
Open questions:
- ...

Правила:
- Не выдумывай факты.
- Сохраняй имена, ID, локации, ассеты и числа.
- Пиши кратко и по делу.
- Максимум 12 пунктов суммарно.`;

export function getThreadSummary(db: Db, threadId: string): string | null {
  const row = db.prepare('SELECT summary FROM thread_summaries WHERE thread_id = ?').get(threadId) as
    | { summary: string }
    | undefined;
  return row?.summary ?? null;
}

export async function compactThreadIfNeeded(
  db: Db,
  threadId: string,
  summarizer: SummarizerFn = defaultSummarizer,
): Promise<boolean> {
  const allMessages = db.prepare(
    "SELECT id, role, content FROM messages WHERE thread_id = ? AND role IN ('user','assistant') ORDER BY id ASC"
  ).all(threadId) as MessageRow[];

  if (allMessages.length === 0) return false;

  const estimatedTokens = estimateTokens(allMessages);
  const tokenTrigger = estimatedTokens >= config.compact.tokenBudget * config.compact.tokenRatio;
  const messageTrigger = allMessages.length >= config.compact.messageThreshold;
  if (!messageTrigger && !tokenTrigger) return false;

  const keepLast = Math.max(1, config.compact.keepLast);
  if (allMessages.length <= keepLast) return false;

  const existingSummaryRow = db.prepare(
    'SELECT summary, last_message_id FROM thread_summaries WHERE thread_id = ?'
  ).get(threadId) as { summary: string; last_message_id: number } | undefined;

  const startId = existingSummaryRow?.last_message_id ?? 0;
  const recentKeep = allMessages.slice(-keepLast);
  const recentKeepMinId = recentKeep[0]?.id ?? Number.MAX_SAFE_INTEGER;
  const candidates = allMessages.filter((msg) => msg.id > startId && msg.id < recentKeepMinId);
  if (candidates.length === 0) return false;

  const lastSummarizedId = candidates[candidates.length - 1].id;
  const summaryText = (await summarizer({
    existingSummary: existingSummaryRow?.summary ?? null,
    messages: candidates,
  })).trim();

  if (!summaryText) return false;

  // Cap summary length to prevent unbounded growth
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

    // Clean up tool messages outside the keep window
    db.prepare("DELETE FROM messages WHERE thread_id = ? AND role = 'tool' AND id < ?").run(threadId, recentKeepMinId);
  });
  tx();
  return true;
}

async function defaultSummarizer(input: {
  existingSummary: string | null;
  messages: MessageRow[];
}): Promise<string> {
  const transcript = buildTranscript(input.messages, config.compact.maxInputChars);
  if (!transcript) return '';

  const userText = [
    input.existingSummary ? `Текущая сводка:\n${input.existingSummary}\n` : '',
    'Новые сообщения для сводки:',
    transcript,
  ].filter(Boolean).join('\n\n');

  return await runModelText(SUMMARY_DEVELOPER_PROMPT, userText);
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

function estimateTokens(messages: MessageRow[]): number {
  const chars = messages.reduce((sum, msg) => sum + msg.content.length, 0);
  return Math.ceil(chars / 4);
}
