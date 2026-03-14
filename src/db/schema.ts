/** SQL statements for creating all tables. Run in order. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id      INTEGER PRIMARY KEY,
  username     TEXT,
  oauth_state  TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_threads (
  thread_id  TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL REFERENCES telegram_sessions(chat_id),
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

CREATE TABLE IF NOT EXISTS eve_accounts (
  character_id    INTEGER PRIMARY KEY,
  character_name  TEXT NOT NULL,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  scopes_json     TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS plans (
  request_id TEXT PRIMARY KEY,
  goal       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS sde_dogma_attributes (
  attribute_id INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  data_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_dogma_attr_name ON sde_dogma_attributes(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sde_dogma_effects (
  effect_id INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_dogma_eff_name ON sde_dogma_effects(name COLLATE NOCASE);

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

CREATE TABLE IF NOT EXISTS sde_blueprints (
  blueprint_type_id INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  data_json         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sde_blueprints_name ON sde_blueprints(name COLLATE NOCASE);
`;
