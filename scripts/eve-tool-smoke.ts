import 'dotenv/config';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { handleAgentMessage } from '../src/agent/executor.js';
import { __test__ } from '../src/agent/executor.js';

const mode = (process.env.EVE_TOOL_SMOKE_MODE || process.argv[2] || 'agent').replace(/^--/, '');
const sourceDb = resolve(process.env.DB_PATH || './data/eve-agent.db');

if (!existsSync(sourceDb)) {
  fail(`DB not found at ${sourceDb}. Run npm run setup first or set DB_PATH.`);
}

const tempDb = join(tmpdir(), `eveai-tool-smoke-${Date.now()}.db`);
copyFileSync(sourceDb, tempDb);
const db = new Database(tempDb);
db.pragma('foreign_keys = ON');

try {
  if (mode === 'direct') {
    await runDirectToolSmoke(db);
  } else if (mode === 'agent') {
    await runAgentToolSmoke(db);
  } else {
    fail(`Unknown EVE_TOOL_SMOKE_MODE: ${mode}. Use agent or direct.`);
  }
} finally {
  db.close();
}

async function runDirectToolSmoke(db: Database.Database): Promise<void> {
  const sql = `
    SELECT
      t.type_id,
      t.name AS type_name,
      g.name AS group_name,
      c.name AS category_name,
      json_extract(t.data_json, '$.mass') AS mass
    FROM sde_types t
    JOIN sde_groups g ON g.group_id = t.group_id
    JOIN sde_categories c ON c.category_id = g.category_id
    WHERE lower(t.name) = lower('Raven')
    LIMIT 1
  `;
  const result = await __test__.executeToolCall(
    db,
    'smoke-direct',
    'Verify Raven SDE lookup',
    { userId: 0, chatId: 0 },
    'sde_sql',
    { sql },
    { normalizedQueries: [], eveKillCallCount: 0 },
  ) as unknown;
  console.log(JSON.stringify({
    ok: true,
    mode: 'direct',
    tool_names: ['sde_sql'],
    result,
  }, null, 2));
}

async function runAgentToolSmoke(db: Database.Database): Promise<void> {
  const chatId = Number(process.env.EVE_TOOL_SMOKE_CHAT_ID || 990000001);
  const threadId = `tool-smoke-${Date.now()}`;
  db.prepare('INSERT OR IGNORE INTO telegram_sessions (chat_id, username) VALUES (?, ?)').run(chatId, 'tool_smoke');
  db.prepare('INSERT INTO agent_threads (thread_id, chat_id, user_id) VALUES (?, ?, ?)').run(threadId, chatId, 0);

  const prompt = process.env.EVE_TOOL_SMOKE_PROMPT
    || 'Проверь через локальную SDE: найди корабль Raven, его type_id, group/category и массу. Обязательно используй tool, не отвечай по памяти. Ответь кратко по-русски.';

  const result = await handleAgentMessage(db, threadId, { userId: 0, chatId }, prompt);
  const toolRows = db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool' ORDER BY id").all(threadId) as Array<{ content: string }>;
  const toolNames = toolRows.map((row) => {
    try {
      const parsed = JSON.parse(row.content) as { tool?: unknown };
      return typeof parsed.tool === 'string' ? parsed.tool : 'unknown';
    } catch {
      return 'unparseable';
    }
  });

  if (toolNames.length === 0) {
    fail('Agent completed without recording any tool calls.');
  }

  console.log(JSON.stringify({
    ok: true,
    mode: 'agent',
    thread_id: threadId,
    tool_count: toolNames.length,
    tool_names: toolNames,
    answer_preview: result.text.slice(0, 1000),
    peak_input_tokens: result.peakInputTokens,
  }, null, 2));
}

function fail(message: string): never {
  console.error(JSON.stringify({ ok: false, error: sanitize(message) }, null, 2));
  process.exit(1);
}

function sanitize(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '[TOKEN_REDACTED]')
    .replace(/sk-[A-Za-z0-9._-]{12,}/g, '[OPENAI_KEY_REDACTED]');
}
