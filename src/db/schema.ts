/** SQL statements for creating all tables. Run in order. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  user_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  active_character_id INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS telegram_accounts (
  telegram_user_id INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(user_id),
  username         TEXT NOT NULL DEFAULT '',
  first_name       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_telegram_accounts_user ON telegram_accounts(user_id);

-- Discord snowflake ids exceed Number.MAX_SAFE_INTEGER, so they are stored as TEXT.
CREATE TABLE IF NOT EXISTS discord_accounts (
  discord_user_id TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(user_id),
  username        TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discord_accounts_user ON discord_accounts(user_id);

-- Maps a Discord DM channel to an internal negative integer chat key so all
-- chat_id-keyed tables (agent_threads, eve_character_links, kill_watches,
-- route_monitors) work unchanged. Telegram private chat ids are positive;
-- Discord chat keys are negative, so the keyspaces never collide.
CREATE TABLE IF NOT EXISTS discord_sessions (
  discord_channel_id TEXT PRIMARY KEY,
  discord_user_id    TEXT NOT NULL,
  user_id            INTEGER NOT NULL REFERENCES users(user_id),
  chat_key           INTEGER NOT NULL UNIQUE,
  username           TEXT,
  last_seen_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discord_sessions_user ON discord_sessions(user_id);

-- The terminal CLI is a local platform lane. Zero is outside Telegram's
-- positive private-chat ids and Discord's negative allocated chat keys, while
-- this row provides an explicit durable owner instead of impersonating a
-- Telegram account.
CREATE TABLE IF NOT EXISTS cli_accounts (
  identity_key TEXT PRIMARY KEY CHECK (identity_key = 'local'),
  user_id      INTEGER NOT NULL UNIQUE REFERENCES users(user_id),
  chat_id      INTEGER NOT NULL UNIQUE CHECK (chat_id = 0),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_requests (
  state        TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('eve_sso', 'tg_handoff')),
  user_id      INTEGER NOT NULL REFERENCES users(user_id),
  chat_id      INTEGER,
  redirect_url TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);

CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id      INTEGER PRIMARY KEY,
  username     TEXT,
  oauth_state  TEXT,
  active_character_id INTEGER,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_threads (
  thread_id  TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL REFERENCES telegram_sessions(chat_id),
  character_id INTEGER,
  user_id    INTEGER,
  last_response_id TEXT,
  last_response_message_id INTEGER,
  total_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL REFERENCES agent_threads(thread_id),
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS thread_summaries (
  thread_id       TEXT PRIMARY KEY REFERENCES agent_threads(thread_id),
  summary         TEXT NOT NULL,
  last_message_id INTEGER NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS thread_artifacts (
  thread_id      TEXT NOT NULL REFERENCES agent_threads(thread_id) ON DELETE CASCADE,
  artifact_kind  TEXT NOT NULL,
  content        TEXT NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (thread_id, artifact_kind)
);

CREATE TABLE IF NOT EXISTS eve_accounts (
  character_id    INTEGER PRIMARY KEY,
  character_name  TEXT NOT NULL,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  scopes_json     TEXT NOT NULL DEFAULT '[]',
  user_id         INTEGER
);

CREATE TABLE IF NOT EXISTS eve_character_links (
  chat_id      INTEGER NOT NULL REFERENCES telegram_sessions(chat_id),
  character_id INTEGER NOT NULL REFERENCES eve_accounts(character_id),
  user_id      INTEGER,
  linked_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_eve_character_links_chat ON eve_character_links(chat_id);
CREATE INDEX IF NOT EXISTS idx_eve_character_links_user ON eve_character_links(user_id);

CREATE INDEX IF NOT EXISTS idx_agent_threads_user ON agent_threads(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

CREATE TABLE IF NOT EXISTS plans (
  request_id TEXT PRIMARY KEY,
  goal       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS esi_cache (
  cache_key     TEXT PRIMARY KEY,
  response_text TEXT NOT NULL,
  etag          TEXT,
  last_modified TEXT,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_esi_cache_expires ON esi_cache(expires_at);

CREATE TABLE IF NOT EXISTS plan_steps (
  request_id      TEXT NOT NULL REFERENCES plans(request_id),
  step_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'action',
  status          TEXT NOT NULL DEFAULT 'pending',
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  notes           TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (request_id, step_id)
);

CREATE TABLE IF NOT EXISTS sde_meta (
  build_number TEXT PRIMARY KEY,
  loaded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sde_raw_records (
  dataset_name TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  name         TEXT,
  data_json    TEXT NOT NULL,
  PRIMARY KEY (dataset_name, record_id)
);
CREATE INDEX IF NOT EXISTS idx_sde_raw_dataset_name ON sde_raw_records(dataset_name, name COLLATE NOCASE);

-- SDE data tables

CREATE TABLE IF NOT EXISTS sde_types (
  type_id    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  group_id   INTEGER,
  data_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_types_name ON sde_types(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_groups (
  group_id    INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  category_id INTEGER,
  data_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_groups_name ON sde_groups(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_categories (
  category_id INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  data_json   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sde_market_groups (
  market_group_id INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  parent_group_id INTEGER,
  data_json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_market_groups_name ON sde_market_groups(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_meta_groups (
  meta_group_id INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  data_json     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_meta_groups_name ON sde_meta_groups(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_dogma_attributes (
  attribute_id INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  data_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_dogma_attr_name ON sde_dogma_attributes(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_dogma_units (
  unit_id    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  data_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_dogma_units_name ON sde_dogma_units(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_dogma_effects (
  effect_id INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_dogma_eff_name ON sde_dogma_effects(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_type_dogma (
  type_id    INTEGER PRIMARY KEY,
  data_json  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sde_type_bonus (
  type_id    INTEGER PRIMARY KEY,
  data_json  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sde_type_materials (
  type_id    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  data_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_type_materials_name ON sde_type_materials(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_certificates (
  certificate_id INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  data_json      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_certificates_name ON sde_certificates(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_masteries (
  type_id    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  data_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_masteries_name ON sde_masteries(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_factions (
  faction_id INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  data_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_factions_name ON sde_factions(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_races (
  race_id    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  data_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_races_name ON sde_races(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_regions (
  region_id INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_regions_name ON sde_regions(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_constellations (
  constellation_id INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  region_id        INTEGER,
  data_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_constellations_name ON sde_constellations(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_systems (
  system_id        INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  constellation_id INTEGER,
  data_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_systems_name ON sde_systems(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_stations (
  station_id INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  system_id  INTEGER,
  data_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_stations_name ON sde_stations(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_npc_corporations (
  corporation_id INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  station_id     INTEGER,
  data_json      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_npc_corporations_name ON sde_npc_corporations(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_stargates (
  stargate_id            INTEGER PRIMARY KEY,
  system_id              INTEGER,
  destination_system_id  INTEGER,
  destination_stargate_id INTEGER,
  data_json              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_stargates_system ON sde_stargates(system_id);

CREATE TABLE IF NOT EXISTS sde_blueprints (
  blueprint_type_id INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  data_json         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_blueprints_name ON sde_blueprints(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS heartbeat_config (
  user_id          INTEGER NOT NULL,
  character_id     INTEGER NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 0,
  interval_seconds INTEGER NOT NULL DEFAULT 3600,
  checks_json      TEXT NOT NULL DEFAULT '["mail"]',
  last_run_at      TEXT,
  last_mail_id     INTEGER,
  state_json       TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, character_id)
);

CREATE TABLE IF NOT EXISTS intel_notes (
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
);

CREATE TABLE IF NOT EXISTS eve_kill_feed_state (
  feed_key         TEXT PRIMARY KEY CHECK (feed_key = 'global'),
  last_sequence_id INTEGER NOT NULL CHECK (last_sequence_id >= 0),
  dedup_pruned_at  TEXT,
  initialized_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kill_watches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  topic      TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (chat_id, topic)
);
CREATE INDEX IF NOT EXISTS idx_kill_watches_chat ON kill_watches(chat_id);

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

CREATE TABLE IF NOT EXISTS route_monitors (
  chat_id             INTEGER PRIMARY KEY,
  character_id        INTEGER NOT NULL,
  origin_id           INTEGER NOT NULL,
  destination_id      INTEGER NOT NULL,
  route_systems       TEXT NOT NULL DEFAULT '[]',
  current_system_id   INTEGER,
  ship_type_id        INTEGER,
  ship_name           TEXT DEFAULT '',
  ship_ehp             REAL DEFAULT 0,
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_location_check TEXT,
  last_online_check   TEXT,
  stats_json          TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS route_ganker_cache (
  character_id   INTEGER NOT NULL,
  system_id      INTEGER NOT NULL,
  character_name TEXT DEFAULT '',
  kill_count     INTEGER DEFAULT 1,
  last_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  ship_type_id   INTEGER,
  PRIMARY KEY (character_id, system_id)
);

CREATE TABLE IF NOT EXISTS route_monitor_kill_dedup (
  chat_id            INTEGER NOT NULL,
  monitor_started_at TEXT NOT NULL,
  killmail_id        INTEGER NOT NULL,
  sequence_id        INTEGER NOT NULL,
  processed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, monitor_started_at, killmail_id)
);
CREATE INDEX IF NOT EXISTS idx_route_monitor_kill_dedup_processed
  ON route_monitor_kill_dedup(processed_at);

CREATE TABLE IF NOT EXISTS eve_kill_migrations (
  migration_key TEXT PRIMARY KEY,
  applied_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
