import type { Db } from './sqlite.js';
import { SCHEMA_SQL } from './schema.js';
import { pathToFileURL } from 'node:url';

export function runMigrations(db: Db): void {
  const migrate = db.transaction(() => {
    ensureSchema(db);
    addColumnIfMissing(db, 'telegram_sessions', 'active_character_id', 'INTEGER');
    addColumnIfMissing(db, 'agent_threads', 'character_id', 'INTEGER');
    addColumnIfMissing(db, 'esi_cache', 'etag', 'TEXT');
    addColumnIfMissing(db, 'esi_cache', 'last_modified', 'TEXT');
    addColumnIfMissing(db, 'agent_threads', 'last_response_id', 'TEXT');
    createIndexIfMissing(db, 'idx_agent_threads_chat_character', 'agent_threads', 'chat_id, character_id');
    backfillThreadCharacters(db);

    addColumnIfMissing(db, 'eve_accounts', 'user_id', 'INTEGER');
    addColumnIfMissing(db, 'eve_character_links', 'user_id', 'INTEGER');
    addColumnIfMissing(db, 'agent_threads', 'user_id', 'INTEGER');
    createIndexIfMissing(db, 'idx_agent_threads_user', 'agent_threads', 'user_id');
    createIndexIfMissing(db, 'idx_eve_character_links_user', 'eve_character_links', 'user_id');
    backfillUsers(db);
  });

  migrate();
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

function backfillUsers(db: Db): void {
  // For each telegram_sessions row, create a user + telegram_account if not already present
  const sessions = db.prepare('SELECT chat_id, username, active_character_id FROM telegram_sessions').all() as
    Array<{ chat_id: number; username: string | null; active_character_id: number | null }>;

  for (const session of sessions) {
    const existing = db.prepare('SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ?')
      .get(session.chat_id) as { user_id: number } | undefined;
    if (existing) continue;

    const displayName = session.username || `tg:${session.chat_id}`;
    const result = db.prepare(
      "INSERT INTO users (display_name, active_character_id, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
    ).run(displayName, session.active_character_id);
    const userId = Number(result.lastInsertRowid);

    db.prepare(
      "INSERT INTO telegram_accounts (telegram_user_id, user_id, username, first_name, created_at) VALUES (?, ?, ?, '', datetime('now'))",
    ).run(session.chat_id, userId, session.username ?? '');

    // Backfill user_id in eve_character_links
    db.prepare('UPDATE eve_character_links SET user_id = ? WHERE chat_id = ? AND user_id IS NULL')
      .run(userId, session.chat_id);

    // Backfill user_id in agent_threads
    db.prepare('UPDATE agent_threads SET user_id = ? WHERE chat_id = ? AND user_id IS NULL')
      .run(userId, session.chat_id);
  }

  // Backfill user_id in eve_accounts from eve_character_links
  db.prepare(`
    UPDATE eve_accounts SET user_id = (
      SELECT l.user_id FROM eve_character_links l
      WHERE l.character_id = eve_accounts.character_id AND l.user_id IS NOT NULL
      LIMIT 1
    ) WHERE user_id IS NULL
  `).run();
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
