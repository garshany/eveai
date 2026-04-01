/**
 * EVE-KILL (Thessia) API types.
 * Base URL: https://eve-kill.com/api/
 * Docs: https://github.com/EVE-KILL/Thessia/tree/main/docs/
 */

// ---------------------------------------------------------------------------
// Killmail
// ---------------------------------------------------------------------------

/** Killmail as returned by /api/killmail/{id} or query results. */
export type EveKillKillmail = {
  killmail_id: number;
  kill_time?: string;
  system_id?: number;
  system_name?: string;
  system_security?: number;
  region_id?: number;
  region_name?: string;
  total_value?: number;
  fitted_value?: number;
  dropped_value?: number;
  destroyed_value?: number;
  point_value?: number;
  is_npc?: boolean;
  is_solo?: boolean;
  is_awox?: boolean;
  labels?: string[];
  victim?: EveKillEntity;
  attackers?: EveKillEntity[];
  items?: EveKillItem[];
  [key: string]: unknown;
};

export type EveKillEntity = {
  character_id?: number;
  character_name?: string;
  corporation_id?: number;
  corporation_name?: string;
  alliance_id?: number;
  alliance_name?: string;
  faction_id?: number;
  faction_name?: string;
  ship_type_id?: number;
  ship_name?: string;
  ship_group_name?: string;
  weapon_type_id?: number;
  weapon_name?: string;
  damage_done?: number;
  final_blow?: boolean;
  [key: string]: unknown;
};

export type EveKillItem = {
  type_id?: number;
  type_name?: string;
  flag?: number;
  quantity_dropped?: number;
  quantity_destroyed?: number;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Query API (POST /api/query)
// ---------------------------------------------------------------------------

/** MongoDB-style filter operators. */
export type QueryFilter = Record<string, unknown>;

export type QueryOptions = {
  limit?: number;
  skip?: number;
  sort?: Record<string, 1 | -1>;
  projection?: Record<string, 0 | 1>;
};

export type QueryRequest = {
  filter: QueryFilter;
  options?: QueryOptions;
};

export type QueryResponse = EveKillKillmail[];

// ---------------------------------------------------------------------------
// Stats / Top / Battles
// ---------------------------------------------------------------------------

export type EntityStats = {
  kills?: number;
  losses?: number;
  isk_destroyed?: number;
  isk_lost?: number;
  solo_kills?: number;
  [key: string]: unknown;
};

export type TopEntry = {
  id?: number;
  name?: string;
  count?: number;
  [key: string]: unknown;
};

export type BattleSummary = {
  id?: number | string;
  system_id?: number;
  system_name?: string;
  start_time?: string;
  end_time?: string;
  kills?: number;
  total_value?: number;
  [key: string]: unknown;
};

export type SearchResult = {
  hits?: Array<{
    id?: number;
    name?: string;
    type?: string;
    [key: string]: unknown;
  }>;
  entityCounts?: Record<string, number>;
  entityOrder?: string[];
  isExactMatch?: boolean;
  [key: string]: unknown;
};

export type BuildPrice = {
  type_id?: number;
  build_price?: number;
  materials?: Array<{
    type_id?: number;
    type_name?: string;
    quantity?: number;
    price?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Compact killmail for agent output (token-efficient)
// ---------------------------------------------------------------------------

export type CompactKill = {
  killmail_id: number;
  time: string | null;
  system: string | null;
  system_sec: number | null;
  region: string | null;
  victim_name: string | null;
  victim_corp: string | null;
  victim_alliance: string | null;
  victim_ship: string | null;
  attacker_name: string | null;
  attacker_corp: string | null;
  attacker_ship: string | null;
  attacker_weapon: string | null;
  attackers_count: number;
  value_m: number;
  solo: boolean;
  npc: boolean;
  url: string;
};

// ---------------------------------------------------------------------------
// Tool parameter types
// ---------------------------------------------------------------------------

export type KillFeedScope = 'system' | 'character' | 'corporation' | 'alliance' | 'ship_type';
export type ActivityFilter = 'kills' | 'losses' | 'all';

export type KillFeedArgs = {
  scope: KillFeedScope;
  id: number;
  activity?: ActivityFilter;
  past_seconds?: number;
  limit?: number;
  detail_limit?: number;
  fields?: string[] | null;
};

export type KillQueryArgs = {
  filter: QueryFilter;
  sort?: Record<string, 1 | -1> | null;
  limit?: number;
  fields?: string[] | null;
};

export type KillIntelAction =
  | 'stats' | 'shortstats' | 'top' | 'battles' | 'battle_detail'
  | 'coalition' | 'corp_history' | 'alliance_history' | 'members'
  | 'search' | 'build_price' | 'type_prices' | 'global_stats'
  | 'near_celestial' | 'near_coordinates'
  | 'killmail' | 'killmail_batch' | 'killmail_sibling'
  | 'entity_detail' | 'alliance_corps'
  | 'war' | 'war_killmails' | 'faction';

export type KillIntelScope = 'character' | 'corporation' | 'alliance';

export type KillIntelArgs = {
  action: KillIntelAction;
  scope?: KillIntelScope | null;
  id?: number | null;
  top_type?: 'ships' | 'systems' | 'regions' | null;
  days?: number;
  limit?: number;
  search_term?: string | null;
  type_id?: number | null;
  celestial_id?: number | null;
  distance_meters?: number | null;
  battle_id?: number | string | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  ids?: number[] | null;
};

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export type EveKillConfig = {
  baseUrl: string;
  wsUrl: string;
  timeoutMs: number;
  cacheTtlSeconds: number;
  maxQueryLimit: number;
  userAgent: string;
  wsEnabled: boolean;
  wsBufferSize: number;
};
