/**
 * Types for the public EVE-KILL v1 API at https://api.eve-kill.com.
 *
 * API payloads are deliberately kept separate from NormalizedKillmail. Callers
 * should never depend on whether a value came from a flat list row, an enriched
 * detail response, or an ESI-compatible search/feed payload.
 */

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

export type Pagination = {
  hasMore: boolean;
  cursor: number | null;
};

export type KillmailActivity = 'kills' | 'losses' | 'all';
export type EntityScope = 'character' | 'corporation' | 'alliance';
export type EntityApiScope = 'characters' | 'corporations' | 'alliances';

export type Position3d = { x: number; y: number; z: number };

export type KillmailEntity = {
  characterId?: number;
  corporationId?: number;
  allianceId?: number;
  factionId?: number;
  characterName?: string;
  corporationName?: string;
  allianceName?: string;
  factionName?: string;
  shipTypeId?: number;
  shipName?: string;
  shipGroupName?: string;
  weaponTypeId?: number;
  weaponName?: string;
  damageDone?: number;
  damageTaken?: number;
  finalBlow?: boolean;
};

export type KillmailItem = {
  typeId: number;
  typeName?: string;
  flag?: number;
  flagName?: string;
  quantityDropped: number;
  quantityDestroyed: number;
  singleton?: number;
  price?: number;
  totalValue?: number;
};

export type NormalizedKillmail = {
  killmailId: number;
  killmailHash?: string;
  killmailTime?: string;
  solarSystemId?: number;
  solarSystemName?: string;
  solarSystemSecurity?: number;
  constellationId?: number;
  regionId?: number;
  regionName?: string;
  totalValue?: number;
  fittedValue?: number;
  droppedValue?: number;
  destroyedValue?: number;
  points?: number;
  attackerCount: number;
  isNpc?: boolean;
  isSolo?: boolean;
  victim: KillmailEntity;
  attackers: KillmailEntity[];
  items: KillmailItem[];
  position?: Position3d;
  siblings: NormalizedKillmail[];
  /** `all` means the scoped entity appeared on both sides of this killmail. */
  activity?: KillmailActivity;
  sourceShape: 'summary' | 'esi' | 'detail' | 'feed';
};

export type KillmailPage = {
  kills: NormalizedKillmail[];
  pagination: Pagination;
};

export type KillmailCollection = {
  kills: NormalizedKillmail[];
  truncated: boolean;
  requestCount: number;
};

export const SEARCH_FILTER_KEYS = [
  'system_ids',
  'constellation_ids',
  'region_ids',
  'character_ids',
  'corporation_ids',
  'alliance_ids',
] as const;

export type SearchFilterKey = typeof SEARCH_FILTER_KEYS[number];

export type KillmailSearchRequest = {
  from: string;
  to: string;
  system_ids?: number[];
  constellation_ids?: number[];
  region_ids?: number[];
  character_ids?: number[];
  corporation_ids?: number[];
  alliance_ids?: number[];
};

export type KillmailSearchResult = KillmailCollection & {
  windows: Array<{ from: string; to: string }>;
};

export type FeedEvent = {
  sequenceId: number;
  killmail: NormalizedKillmail;
};

export type FeedPage = {
  events: FeedEvent[];
  latest: number;
  hasMore: boolean;
  next: string | null;
  last: string | null;
};

export type FeedWatchMatch = {
  watchId: number;
  chatId: number;
  topic: string;
  label: string;
};

export type CharacterTopShip = {
  shipTypeId: number;
  shipName?: string;
  kills: number;
  losses: number;
};

export type EntityStats = {
  id: number;
  name?: string;
  period?: string;
  kills: number;
  losses: number;
  soloKills: number;
  npcLosses: number;
  iskDestroyed: number;
  iskLost: number;
  efficiency?: number;
  iskEfficiency?: number;
  topShips: CharacterTopShip[];
};

export type BatchEntityStats = {
  period: string;
  results: EntityStats[];
  requestedIds: number[];
  resolvedIds: number[];
  missingIds: number[];
  truncated: boolean;
  requestCount: number;
};

export type EveKillConfig = {
  baseUrl: string;
  timeoutMs: number;
  userAgent: string;
  retryMaxAttempts: number;
  backoffMaxMs: number;
};
