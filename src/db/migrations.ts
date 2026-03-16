import type { Db } from './sqlite.js';
import { SCHEMA_SQL } from './schema.js';
import { pathToFileURL } from 'node:url';

export function runMigrations(db: Db): void {
  ensureSchema(db);
  addColumnIfMissing(db, 'telegram_sessions', 'active_character_id', 'INTEGER');
  addColumnIfMissing(db, 'agent_threads', 'character_id', 'INTEGER');
  addColumnIfMissing(db, 'esi_cache', 'etag', 'TEXT');
  addColumnIfMissing(db, 'esi_cache', 'last_modified', 'TEXT');
  createIndexIfMissing(db, 'idx_agent_threads_chat_character', 'agent_threads', 'chat_id, character_id');
  backfillActiveCharacters(db);
  backfillThreadCharacters(db);
}

function ensureSchema(db: Db): void {
  try {
    db.exec(SCHEMA_SQL);
  } catch (err) {
    const msg = String((err as Error).message || err);
    if (msg.includes('no such column')) {
      db.exec(SCHEMA_SQL);
      return;
    }
    throw err;
  }
}

function addColumnIfMissing(db: Db, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function createIndexIfMissing(db: Db, index: string, table: string, columns: string): void {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name = ?"
  ).get(index) as { name: string } | undefined;
  if (row?.name) return;
  db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(${columns})`);
}

function backfillActiveCharacters(db: Db): void {
  const account = db.prepare('SELECT character_id FROM eve_accounts ORDER BY character_id LIMIT 1').get() as
    | { character_id: number }
    | undefined;
  if (!account) return;

  const sessions = db.prepare('SELECT chat_id, active_character_id FROM telegram_sessions').all() as
    Array<{ chat_id: number; active_character_id: number | null }>;

  for (const session of sessions) {
    if (session.active_character_id) continue;
    db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?').run(
      account.character_id,
      session.chat_id,
    );
    const exists = db.prepare(
      'SELECT 1 FROM eve_character_links WHERE chat_id = ? AND character_id = ?'
    ).get(session.chat_id, account.character_id);
    if (!exists) {
      db.prepare(
        'INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)'
      ).run(session.chat_id, account.character_id);
    }
  }
}

function backfillThreadCharacters(db: Db): void {
  const rows = db.prepare('SELECT thread_id, chat_id, character_id FROM agent_threads').all() as
    Array<{ thread_id: string; chat_id: number; character_id: number | null }>;

  for (const row of rows) {
    if (row.character_id) continue;
    const active = db.prepare('SELECT active_character_id FROM telegram_sessions WHERE chat_id = ?')
      .get(row.chat_id) as { active_character_id: number | null } | undefined;
    if (active?.active_character_id) {
      db.prepare('UPDATE agent_threads SET character_id = ? WHERE thread_id = ?')
        .run(active.active_character_id, row.thread_id);
    }
  }
}

async function main(): Promise<void> {
  const { initDb } = await import('./sqlite.js');
  const { config } = await import('../config.js');
  const db = initDb(config.db.path);
  runMigrations(db);
  db.close();
  console.log('[migrations] Done');
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  void main();
}
