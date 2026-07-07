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
    clearLegacyOauthStates(db);
    addColumnIfMissing(db, 'agent_threads', 'total_tokens', 'INTEGER DEFAULT 0');
    createIndexIfMissing(db, 'idx_messages_thread', 'messages', 'thread_id');
    ensureHeartbeatConfig(db);
    addColumnIfMissing(db, 'heartbeat_config', 'state_json', "TEXT NOT NULL DEFAULT '{}'");
    ensureKillWatches(db);
    ensureRouteMonitors(db);
    ensureIntelNotes(db);
    dropLegacyWebTables(db);
  });

  migrate();
}

function ensureSchema(db: Db): void {
  try {
    db.exec(SCHEMA_SQL);
    return;
  } catch (err) {
    const msg = String((err as Error).message || err);
    // The only tolerated failure is an inline CREATE INDEX in SCHEMA_SQL that
    // references a column a later addColumnIfMissing() adds — happens on legacy
    // DBs whose table predates that column. Anything else is a real error.
    if (!msg.includes('no such column')) throw err;
  }

  // Re-apply statement-by-statement, skipping only the index creations that
  // reference not-yet-added columns. The matching createIndexIfMissing() call
  // recreates them after addColumnIfMissing() runs. All CREATEs use IF NOT
  // EXISTS, so this stays idempotent. (SCHEMA_SQL contains no ';' inside string
  // literals, so a naive split is safe.)
  for (const raw of SCHEMA_SQL.split(';')) {
    const stmt = raw.trim();
    if (!stmt) continue;
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = String((err as Error).message || err);
      if (msg.includes('no such column') && /^CREATE\s+INDEX/i.test(stmt)) {
        continue;
      }
      throw err;
    }
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
  // Legacy backfill for pre-user_id Telegram DBs. Telegram private chat ids are
  // positive; Discord DM lanes reuse telegram_sessions with NEGATIVE chat keys
  // and 0 is a legacy web placeholder — neither is a Telegram user, so excluding
  // chat_id <= 0 prevents fabricating a bogus telegram_account (with a negative
  // telegram_user_id) for every Discord lane on each boot.
  const sessions = db.prepare('SELECT chat_id, username, active_character_id FROM telegram_sessions WHERE chat_id > 0').all() as
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

function ensureHeartbeatConfig(db: Db): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='heartbeat_config'"
  ).get();
  if (!exists) {
    db.exec(`
      CREATE TABLE heartbeat_config (
        user_id          INTEGER NOT NULL,
        character_id     INTEGER NOT NULL,
        enabled          INTEGER NOT NULL DEFAULT 0,
        interval_seconds INTEGER NOT NULL DEFAULT 3600,
        checks_json      TEXT NOT NULL DEFAULT '["mail"]',
        last_run_at      TEXT,
        last_mail_id     INTEGER,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, character_id)
      )
    `);
  }
}

function ensureKillWatches(db: Db): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='kill_watches'",
  ).get();
  if (!exists) {
    db.exec(`
      CREATE TABLE kill_watches (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     INTEGER NOT NULL,
        topic       TEXT NOT NULL,
        label       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(chat_id, topic)
      )
    `);
    db.exec('CREATE INDEX idx_kill_watches_chat ON kill_watches(chat_id)');
  }
}

function ensureRouteMonitors(db: Db): void {
  const hasMonitors = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='route_monitors'",
  ).get();
  if (!hasMonitors) {
    db.exec(`
      CREATE TABLE route_monitors (
        chat_id            INTEGER PRIMARY KEY,
        character_id       INTEGER NOT NULL,
        origin_id          INTEGER NOT NULL,
        destination_id     INTEGER NOT NULL,
        route_systems      TEXT NOT NULL DEFAULT '[]',
        current_system_id  INTEGER,
        ship_type_id       INTEGER,
        ship_name          TEXT DEFAULT '',
        ship_ehp           REAL DEFAULT 0,
        started_at         TEXT NOT NULL DEFAULT (datetime('now')),
        last_location_check TEXT,
        last_online_check  TEXT,
        stats_json         TEXT NOT NULL DEFAULT '{}',
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  const hasGankerCache = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='route_ganker_cache'",
  ).get();
  if (!hasGankerCache) {
    db.exec(`
      CREATE TABLE route_ganker_cache (
        character_id     INTEGER NOT NULL,
        system_id        INTEGER NOT NULL,
        character_name   TEXT DEFAULT '',
        kill_count       INTEGER DEFAULT 1,
        last_seen        TEXT NOT NULL DEFAULT (datetime('now')),
        ship_type_id     INTEGER,
        PRIMARY KEY (character_id, system_id)
      )
    `);
  }
}

function ensureIntelNotes(db: Db): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='intel_notes'",
  ).get();
  if (!exists) {
    db.exec(`
      CREATE TABLE intel_notes (
        note_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        system_id    INTEGER,
        system_name  TEXT,
        region_id    INTEGER,
        region_name  TEXT,
        entity_name  TEXT,
        tag          TEXT NOT NULL DEFAULT 'general',
        text         TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX idx_intel_notes_user ON intel_notes(user_id)');
    db.exec('CREATE INDEX idx_intel_notes_system ON intel_notes(user_id, system_id)');
    db.exec('CREATE INDEX idx_intel_notes_region ON intel_notes(user_id, region_id)');
  }
}

function clearLegacyOauthStates(db: Db): void {
  db.prepare('UPDATE telegram_sessions SET oauth_state = NULL WHERE oauth_state IS NOT NULL').run();
}

function dropLegacyWebTables(db: Db): void {
  // The web dashboard was removed; browser sessions and Telegram Login Widget
  // nonces have no consumers anymore.
  db.exec('DROP TABLE IF EXISTS web_sessions');
  db.exec('DROP TABLE IF EXISTS telegram_login_attempts');
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
