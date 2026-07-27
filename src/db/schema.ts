/** SQL statements for creating all tables. Run in order. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  user_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  active_character_id INTEGER,
  active_character_version INTEGER NOT NULL DEFAULT 0,
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
  requested_scopes_json TEXT,
  consent_version TEXT,
  consent_language TEXT CHECK (consent_language IS NULL OR consent_language IN ('ru', 'en')),
  consented_at TEXT,
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

-- Browser-only identities use opaque, keyed-hash sessions and a chat-id range
-- reserved away from Telegram (>0), CLI (0), and Discord (-1, -2, ...).
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
  web_request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_web_request ON messages(web_request_id);

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
  consent_version TEXT,
  consent_language TEXT CHECK (consent_language IS NULL OR consent_language IN ('ru', 'en')),
  consented_at    TEXT,
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
  stream_text      TEXT NOT NULL DEFAULT '',
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
);
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
  event_kind     TEXT NOT NULL CHECK (event_kind IN ('session', 'chat', 'ai-search')),
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

-- Character datastore: materialized private ESI profile, one row set per
-- character. Every table carries character_id and synced_at. The character_sql
-- agent tool only ever sees rows of the currently active character through
-- per-query TEMP views (see src/agent/tools/character-execution.ts). Rows are
-- replaced or upserted by src/eve/character-sync.ts and deleted on unlink/purge.

CREATE TABLE IF NOT EXISTS character_assets (
  character_id      INTEGER NOT NULL,
  item_id           INTEGER NOT NULL,
  type_id           INTEGER NOT NULL,
  location_id       INTEGER NOT NULL,
  location_type     TEXT,
  location_flag     TEXT,
  quantity          INTEGER,
  is_singleton      INTEGER NOT NULL DEFAULT 0,
  is_blueprint_copy INTEGER,
  data_json         TEXT NOT NULL,
  synced_at         TEXT NOT NULL,
  PRIMARY KEY (character_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_character_assets_type ON character_assets(character_id, type_id);
CREATE INDEX IF NOT EXISTS idx_character_assets_location ON character_assets(character_id, location_id);

CREATE TABLE IF NOT EXISTS character_wallet (
  character_id INTEGER PRIMARY KEY,
  balance      REAL NOT NULL DEFAULT 0,
  synced_at    TEXT NOT NULL
);

-- Append-only: journal rows accumulate via INSERT OR REPLACE (ids are stable),
-- so history predating the sync page cap is preserved across refreshes.
CREATE TABLE IF NOT EXISTS character_wallet_journal (
  character_id    INTEGER NOT NULL,
  journal_id      INTEGER NOT NULL,
  date            TEXT,
  ref_type        TEXT,
  amount          REAL,
  balance         REAL,
  first_party_id  INTEGER,
  second_party_id INTEGER,
  description     TEXT,
  context_id      INTEGER,
  context_id_type TEXT,
  data_json       TEXT NOT NULL,
  synced_at       TEXT NOT NULL,
  PRIMARY KEY (character_id, journal_id)
);
CREATE INDEX IF NOT EXISTS idx_character_wallet_journal_date
  ON character_wallet_journal(character_id, date);

CREATE TABLE IF NOT EXISTS character_orders (
  character_id  INTEGER NOT NULL,
  order_id      INTEGER NOT NULL,
  type_id       INTEGER NOT NULL,
  region_id     INTEGER,
  location_id   INTEGER,
  price         REAL,
  volume_total  INTEGER,
  volume_remain INTEGER,
  min_volume    INTEGER,
  is_buy_order  INTEGER NOT NULL DEFAULT 0,
  range         TEXT,
  duration      INTEGER,
  issued        TEXT,
  escrow        REAL,
  data_json     TEXT NOT NULL,
  synced_at     TEXT NOT NULL,
  PRIMARY KEY (character_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_character_orders_type ON character_orders(character_id, type_id);

CREATE TABLE IF NOT EXISTS character_contracts (
  character_id      INTEGER NOT NULL,
  contract_id       INTEGER NOT NULL,
  type              TEXT,
  status            TEXT,
  availability      TEXT,
  price             REAL,
  reward            REAL,
  collateral        REAL,
  volume            REAL,
  title             TEXT,
  date_issued       TEXT,
  date_expired      TEXT,
  date_accepted     TEXT,
  date_completed    TEXT,
  issuer_id         INTEGER,
  assignee_id       INTEGER,
  acceptor_id       INTEGER,
  start_location_id INTEGER,
  end_location_id   INTEGER,
  for_corporation   INTEGER,
  data_json         TEXT NOT NULL,
  synced_at         TEXT NOT NULL,
  PRIMARY KEY (character_id, contract_id)
);
CREATE INDEX IF NOT EXISTS idx_character_contracts_status
  ON character_contracts(character_id, status);

CREATE TABLE IF NOT EXISTS character_skills (
  character_id         INTEGER NOT NULL,
  skill_id             INTEGER NOT NULL,
  trained_skill_level  INTEGER,
  active_skill_level   INTEGER,
  skillpoints_in_skill INTEGER,
  data_json            TEXT NOT NULL,
  synced_at            TEXT NOT NULL,
  PRIMARY KEY (character_id, skill_id)
);

CREATE TABLE IF NOT EXISTS character_skillqueue (
  character_id      INTEGER NOT NULL,
  queue_position    INTEGER NOT NULL,
  skill_id          INTEGER,
  finished_level    INTEGER,
  start_date        TEXT,
  finish_date       TEXT,
  training_start_sp INTEGER,
  level_start_sp    INTEGER,
  level_end_sp      INTEGER,
  data_json         TEXT NOT NULL,
  synced_at         TEXT NOT NULL,
  PRIMARY KEY (character_id, queue_position)
);

CREATE TABLE IF NOT EXISTS character_clones (
  character_id  INTEGER NOT NULL,
  jump_clone_id INTEGER NOT NULL,
  location_id   INTEGER,
  location_type TEXT,
  name          TEXT,
  implants_json TEXT NOT NULL DEFAULT '[]',
  data_json     TEXT NOT NULL,
  synced_at     TEXT NOT NULL,
  PRIMARY KEY (character_id, jump_clone_id)
);

CREATE TABLE IF NOT EXISTS character_standings (
  character_id INTEGER NOT NULL,
  from_id      INTEGER NOT NULL,
  from_type    TEXT NOT NULL,
  standing     REAL,
  data_json    TEXT NOT NULL,
  synced_at    TEXT NOT NULL,
  PRIMARY KEY (character_id, from_type, from_id)
);

-- Location + ship + online merged into one row per character.
CREATE TABLE IF NOT EXISTS character_presence (
  character_id     INTEGER PRIMARY KEY,
  solar_system_id  INTEGER,
  station_id       INTEGER,
  structure_id     INTEGER,
  ship_type_id     INTEGER,
  ship_name        TEXT,
  ship_item_id     INTEGER,
  online           INTEGER,
  last_login       TEXT,
  last_logout      TEXT,
  synced_at        TEXT NOT NULL
);

-- Singleton rollups that do not fit the per-row datasets above.
CREATE TABLE IF NOT EXISTS character_profile (
  character_id             INTEGER PRIMARY KEY,
  character_name           TEXT,
  total_skill_points       INTEGER,
  unallocated_skill_points INTEGER,
  implants_json            TEXT NOT NULL DEFAULT '[]',
  home_location_json       TEXT,
  synced_at                TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_sync_state (
  character_id INTEGER NOT NULL,
  dataset      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ok', 'error', 'no_scope')),
  rows_synced  INTEGER NOT NULL DEFAULT 0,
  synced_at    TEXT,
  expires_at   TEXT,
  error        TEXT,
  PRIMARY KEY (character_id, dataset)
);

-- Whole-New-Eden market snapshot walked directly from public ESI
-- (/markets/{region_id}/orders/, one 1000-order page at a time).
-- The loader never updates this table in place: it fills a staging table and
-- swaps it in atomically (drop + rename in one transaction), so executed/
-- cancelled orders vanish instead of lingering as ghosts. The three indexes
-- are NOT created here: the loader builds them on the staging table under
-- per-pass names before the swap (index names are schema-global and DROP
-- TABLE carries a table's indexes away with it), so no rebuild ever happens
-- inside the swap transaction. See src/eve/market-snapshot-loader.ts.
CREATE TABLE IF NOT EXISTS market_orders (
  order_id      INTEGER PRIMARY KEY,
  type_id       INTEGER NOT NULL,
  region_id     INTEGER NOT NULL,
  system_id     INTEGER NOT NULL,
  station_id    INTEGER,
  location_id   INTEGER NOT NULL,
  is_buy_order  INTEGER NOT NULL,
  price         REAL    NOT NULL,
  volume_remain INTEGER NOT NULL,
  volume_total  INTEGER NOT NULL,
  min_volume    INTEGER NOT NULL,
  duration      INTEGER NOT NULL,
  range         TEXT    NOT NULL,
  issued        TEXT    NOT NULL
);

-- Loader/snapshot metadata (singleton, same pattern as eve_kill_feed_state).
-- Survives restarts. Readers report snapshot_time as the data age: it is the
-- OLDEST region's fetched_at in the serving book (the swapped table mixes
-- rows of different ages), not the moment of the last tick. snapshot_etag is
-- unused by the ESI sweep (no upstream file to compare) and stays NULL.
CREATE TABLE IF NOT EXISTS market_snapshot_state (
  feed_key        TEXT PRIMARY KEY CHECK (feed_key = 'global'),
  status          TEXT NOT NULL DEFAULT 'idle',
  snapshot_url    TEXT,
  snapshot_etag   TEXT,
  snapshot_time   TEXT,
  rows_loaded     INTEGER,
  loaded_at       TEXT,
  last_error      TEXT,
  last_attempt_at TEXT
);

-- Per-region freshness for the two-tier sweep: a region is refetched only
-- when fetched_at + its tier interval (major/minor by page count) has passed,
-- and never before expires_at (ESI's own 5-minute order-book cache).
CREATE TABLE IF NOT EXISTS market_snapshot_regions (
  region_id   INTEGER PRIMARY KEY,
  pages       INTEGER,
  rows_loaded INTEGER,
  fetched_at  TEXT,
  expires_at  TEXT,
  last_error  TEXT
);

-- Local daily price history accumulated from ESI /markets/{region_id}/history/.
-- Rows are never deleted once synced, so over time this outlives ESI's own
-- ~365-day window. Populated lazily (backfill on first view) and by the
-- market history worker (see src/eve/market-history.ts).
CREATE TABLE IF NOT EXISTS market_price_history (
  region_id   INTEGER NOT NULL,
  type_id     INTEGER NOT NULL,
  date        TEXT NOT NULL,
  order_count INTEGER NOT NULL,
  volume      INTEGER NOT NULL,
  highest     REAL NOT NULL,
  average     REAL NOT NULL,
  lowest      REAL NOT NULL,
  synced_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (region_id, type_id, date)
);

-- Per-(region, type) sync state for the history backfiller/worker. next_due_at
-- is the next ESI refresh (daily at 11:05 UTC plus a buffer) after which a new
-- history day may exist. The worker picks due pairs by this column.
CREATE TABLE IF NOT EXISTS market_history_sync (
  region_id      INTEGER NOT NULL,
  type_id        INTEGER NOT NULL,
  last_synced_at TEXT,
  next_due_at    TEXT,
  status         TEXT NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok', 'error')),
  error          TEXT,
  PRIMARY KEY (region_id, type_id)
);
CREATE INDEX IF NOT EXISTS idx_market_history_sync_due
  ON market_history_sync(next_due_at);

-- Web market watchlist. region_id is always stored as a concrete value:
-- writers substitute the user's default region when the caller omits it,
-- because the (user_id, type_id, region_id) primary key treats NULL as
-- distinct and would let duplicates through.
CREATE TABLE IF NOT EXISTS market_watchlist (
  user_id    INTEGER NOT NULL,
  type_id    INTEGER NOT NULL,
  region_id  INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, type_id, region_id)
);

-- Price alerts evaluated against the local market_orders snapshot by the
-- alerts worker. 'triggered' rows keep triggered_at/trigger_price as evidence.
CREATE TABLE IF NOT EXISTS market_price_alerts (
  alert_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  type_id         INTEGER NOT NULL,
  region_id       INTEGER NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('sell', 'buy')),
  comparator      TEXT NOT NULL CHECK (comparator IN ('above', 'below')),
  threshold_price REAL NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'triggered', 'disabled')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  triggered_at    TEXT,
  trigger_price   REAL
);
CREATE INDEX IF NOT EXISTS idx_market_price_alerts_user_status
  ON market_price_alerts(user_id, status);

-- Append-only firing log for market_price_alerts. delivered_at flips when the
-- outbound lane (Telegram/web) has pushed the notification. Rows stay visible
-- in the UI regardless of delivery.
CREATE TABLE IF NOT EXISTS market_alert_events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id     INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  type_id      INTEGER NOT NULL,
  price        REAL NOT NULL,
  threshold    REAL NOT NULL,
  triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_market_alert_events_user
  ON market_alert_events(user_id, triggered_at);
`;
