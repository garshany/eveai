import type { Db } from './sqlite.js';
import { SCHEMA_SQL } from './schema.js';
import { pathToFileURL } from 'node:url';

export function runMigrations(db: Db): void {
  const migrate = db.transaction(() => {
    ensureSchema(db);
    addColumnIfMissing(db, 'telegram_sessions', 'active_character_id', 'INTEGER');
    addColumnIfMissing(db, 'users', 'active_character_version', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'agent_threads', 'character_id', 'INTEGER');
    addColumnIfMissing(db, 'esi_cache', 'etag', 'TEXT');
    addColumnIfMissing(db, 'esi_cache', 'last_modified', 'TEXT');
    addColumnIfMissing(db, 'agent_threads', 'last_response_id', 'TEXT');
    addColumnIfMissing(db, 'agent_threads', 'last_response_message_id', 'INTEGER');
    createIndexIfMissing(db, 'idx_agent_threads_chat_character', 'agent_threads', 'chat_id, character_id');
    backfillThreadCharacters(db);

    addColumnIfMissing(db, 'eve_accounts', 'user_id', 'INTEGER');
    addColumnIfMissing(db, 'eve_accounts', 'consent_version', 'TEXT');
    addColumnIfMissing(db, 'eve_accounts', 'consent_language', 'TEXT');
    addColumnIfMissing(db, 'eve_accounts', 'consented_at', 'TEXT');
    addColumnIfMissing(db, 'eve_character_links', 'user_id', 'INTEGER');
    addColumnIfMissing(db, 'agent_threads', 'user_id', 'INTEGER');
    createIndexIfMissing(db, 'idx_agent_threads_user', 'agent_threads', 'user_id');
    createIndexIfMissing(db, 'idx_eve_character_links_user', 'eve_character_links', 'user_id');
    backfillUsers(db);
    clearLegacyOauthStates(db);
    addColumnIfMissing(db, 'agent_threads', 'total_tokens', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'messages', 'web_request_id', 'TEXT');
    createIndexIfMissing(db, 'idx_messages_thread', 'messages', 'thread_id');
    createIndexIfMissing(db, 'idx_messages_web_request', 'messages', 'web_request_id');
    ensureHeartbeatConfig(db);
    addColumnIfMissing(db, 'heartbeat_config', 'state_json', "TEXT NOT NULL DEFAULT '{}'");
    ensureKillWatches(db);
    ensureEveKillFeedState(db);
    removeLegacyRouteWatchesOnce(db);
    ensureRouteMonitors(db);
    ensureRouteMonitorKillDedup(db);
    cutoverMarkedLegacyCliIdentity(db);
    ensureIntelNotes(db);
    ensureWebSessions(db);
    ensureWebAgentRequests(db);
    addColumnIfMissing(db, 'auth_requests', 'requested_scopes_json', 'TEXT');
    addColumnIfMissing(db, 'auth_requests', 'consent_version', 'TEXT');
    addColumnIfMissing(db, 'auth_requests', 'consent_language', 'TEXT');
    addColumnIfMissing(db, 'auth_requests', 'consented_at', 'TEXT');
    ensureConsentLanguageGuards(db);
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
      if (msg.includes('no such column') && /^CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(stmt)) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * One-time clean cutover for CLI installations created by the former sentinel
 * lane. Numeric id 1 alone is never evidence: the old adapter wrote this exact
 * account/session marker. Conversation and EVE links move to the explicit
 * local lane; background-only state is removed because the CLI cannot deliver
 * it after the process exits.
 */
function cutoverMarkedLegacyCliIdentity(db: Db): void {
  const alreadyMarked = db.prepare(
    "SELECT 1 FROM cli_accounts WHERE identity_key = 'local'",
  ).get();
  if (alreadyMarked) return;

  const legacy = db.prepare(`
    SELECT a.user_id, s.active_character_id
    FROM telegram_accounts a
    JOIN telegram_sessions s ON s.chat_id = a.telegram_user_id
    WHERE a.telegram_user_id = 1
      AND a.username = 'cli'
      AND a.first_name = 'CLI'
      AND s.username = 'cli'
  `).get() as { user_id: number; active_character_id: number | null } | undefined;
  if (!legacy) return;

  db.prepare(`
    INSERT INTO telegram_sessions (chat_id, username, active_character_id, last_seen_at)
    VALUES (0, 'cli', ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      username = 'cli',
      active_character_id = COALESCE(telegram_sessions.active_character_id, excluded.active_character_id),
      last_seen_at = datetime('now')
  `).run(legacy.active_character_id);
  db.prepare('UPDATE agent_threads SET chat_id = 0, user_id = ? WHERE chat_id = 1')
    .run(legacy.user_id);
  db.prepare(`
    INSERT OR IGNORE INTO eve_character_links (chat_id, character_id, user_id, linked_at)
    SELECT 0, character_id, ?, linked_at
    FROM eve_character_links
    WHERE chat_id = 1
  `).run(legacy.user_id);
  db.prepare('DELETE FROM eve_character_links WHERE chat_id = 1').run();
  db.prepare('UPDATE auth_requests SET chat_id = 0 WHERE chat_id = 1 AND user_id = ?')
    .run(legacy.user_id);

  db.prepare('DELETE FROM kill_watches WHERE chat_id = 1').run();
  db.prepare('DELETE FROM route_monitor_kill_dedup WHERE chat_id = 1').run();
  db.prepare('DELETE FROM route_monitors WHERE chat_id = 1').run();
  db.prepare('DELETE FROM eve_kill_notification_dedup WHERE chat_id = 1').run();
  db.prepare('DELETE FROM heartbeat_config WHERE user_id = ?').run(legacy.user_id);
  db.prepare('DELETE FROM telegram_accounts WHERE telegram_user_id = 1 AND user_id = ?')
    .run(legacy.user_id);
  db.prepare('DELETE FROM telegram_sessions WHERE chat_id = 1').run();
  db.prepare(
    "INSERT INTO cli_accounts (identity_key, user_id, chat_id) VALUES ('local', ?, 0)",
  ).run(legacy.user_id);
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

function ensureConsentLanguageGuards(db: Db): void {
  for (const table of ['auth_requests', 'eve_accounts']) {
    for (const event of ['INSERT', 'UPDATE']) {
      const triggerName = `validate_${table}_consent_language_${event.toLowerCase()}`;
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${triggerName}
        BEFORE ${event} ON ${table}
        WHEN NEW.consent_language IS NOT NULL
          AND NEW.consent_language NOT IN ('ru', 'en')
        BEGIN
          SELECT RAISE(ABORT, 'invalid consent_language');
        END
      `);
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

function backfillUsers(db: Db): void {
  // Legacy backfill for pre-user_id Telegram DBs. Telegram private chat ids are
  // positive; Discord DM lanes reuse telegram_sessions with NEGATIVE chat keys
  // and 0 is the local CLI lane (formerly a web placeholder) — neither is a Telegram user, so excluding
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

function ensureEveKillFeedState(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eve_kill_feed_state (
      feed_key         TEXT PRIMARY KEY CHECK (feed_key = 'global'),
      last_sequence_id INTEGER NOT NULL CHECK (last_sequence_id >= 0),
      dedup_pruned_at  TEXT,
      initialized_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS eve_kill_notification_dedup (
      chat_id       INTEGER NOT NULL,
      killmail_id   INTEGER NOT NULL,
      sequence_id   INTEGER NOT NULL,
      delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, killmail_id)
    );
    CREATE INDEX IF NOT EXISTS idx_eve_kill_notification_dedup_sequence
      ON eve_kill_notification_dedup(sequence_id);
    CREATE INDEX IF NOT EXISTS idx_eve_kill_notification_dedup_delivered
      ON eve_kill_notification_dedup(delivered_at);
    CREATE TABLE IF NOT EXISTS eve_kill_migrations (
      migration_key TEXT PRIMARY KEY,
      applied_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  addColumnIfMissing(db, 'eve_kill_feed_state', 'dedup_pruned_at', 'TEXT');
}

function removeLegacyRouteWatchesOnce(db: Db): void {
  const migrationKey = 'remove-legacy-route-watches-v1';
  const applied = db.prepare(
    'SELECT 1 FROM eve_kill_migrations WHERE migration_key = ?',
  ).get(migrationKey);
  if (applied) return;
  db.prepare("DELETE FROM kill_watches WHERE label LIKE '[route] %'").run();
  db.prepare('INSERT INTO eve_kill_migrations (migration_key) VALUES (?)').run(migrationKey);
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

function ensureRouteMonitorKillDedup(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_monitor_kill_dedup (
      chat_id           INTEGER NOT NULL,
      monitor_started_at TEXT NOT NULL,
      killmail_id       INTEGER NOT NULL,
      sequence_id       INTEGER NOT NULL,
      processed_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, monitor_started_at, killmail_id)
    );
    CREATE INDEX IF NOT EXISTS idx_route_monitor_kill_dedup_processed
      ON route_monitor_kill_dedup(processed_at);
  `);
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

function ensureWebSessions(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(web_sessions)').all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some((column) => column.name === 'session_hash')) {
    // Clean cutover from the removed dashboard's incompatible session table.
    db.exec('DROP TABLE web_sessions');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      session_hash TEXT PRIMARY KEY,
      csrf_hash    TEXT NOT NULL,
      user_id      INTEGER NOT NULL REFERENCES users(user_id),
      chat_id      INTEGER NOT NULL UNIQUE REFERENCES telegram_sessions(chat_id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);
  `);
  db.exec('DROP TABLE IF EXISTS telegram_login_attempts');
}

function ensureWebAgentRequests(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_agent_requests (
      request_id       TEXT PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(user_id),
      chat_id          INTEGER NOT NULL REFERENCES telegram_sessions(chat_id),
      thread_id        TEXT NOT NULL REFERENCES agent_threads(thread_id) ON DELETE CASCADE,
      character_id     INTEGER,
      character_version INTEGER NOT NULL,
      message          TEXT NOT NULL,
      message_hash     TEXT NOT NULL,
      idempotency_key  TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      activity_json    TEXT NOT NULL DEFAULT '[]',
      progress_sequence INTEGER NOT NULL DEFAULT 0,
      result_text      TEXT,
      assistant_message_id INTEGER,
      error_code       TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
      cost_reserved    INTEGER NOT NULL DEFAULT 1,
      cost_actual      INTEGER NOT NULL DEFAULT 0,
      created_at_ms    INTEGER NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      started_at       TEXT,
      heartbeat_at     TEXT,
      lease_expires_at TEXT,
      finished_at      TEXT,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  addColumnIfMissing(db, 'web_agent_requests', 'character_id', 'INTEGER');
  addColumnIfMissing(db, 'web_agent_requests', 'character_version', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'web_agent_requests', 'idempotency_key', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'web_agent_requests', 'progress_sequence', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'web_agent_requests', 'assistant_message_id', 'INTEGER');
  addColumnIfMissing(db, 'web_agent_requests', 'cost_reserved', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'web_agent_requests', 'cost_actual', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'web_agent_requests', 'heartbeat_at', 'TEXT');
  addColumnIfMissing(db, 'web_agent_requests', 'lease_expires_at', 'TEXT');
  db.prepare(`
    UPDATE web_agent_requests SET idempotency_key = request_id WHERE idempotency_key = ''
  `).run();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_web_agent_requests_status
      ON web_agent_requests(status, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_web_agent_requests_actor
      ON web_agent_requests(user_id, chat_id, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_web_agent_requests_thread
      ON web_agent_requests(thread_id, created_at_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_web_agent_requests_idempotency
      ON web_agent_requests(user_id, chat_id, idempotency_key);
    CREATE TABLE IF NOT EXISTS web_admission_events (
      event_id       TEXT PRIMARY KEY,
      event_kind     TEXT NOT NULL CHECK (event_kind IN ('session', 'chat')),
      user_id        INTEGER,
      ip_key         TEXT NOT NULL,
      cost_units     INTEGER NOT NULL DEFAULT 0,
      created_at_ms  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_web_admission_events_kind_time
      ON web_admission_events(event_kind, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_web_admission_events_ip_time
      ON web_admission_events(ip_key, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_web_admission_events_user_time
      ON web_admission_events(user_id, created_at_ms);
  `);
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
