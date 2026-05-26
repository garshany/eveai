/**
 * kill_feed tool execution — recent kills by system, entity, or ship type.
 */

import type { Db } from '../db/sqlite.js';
import type {
  KillFeedArgs,
  CompactKill,
  ActivityFilter,
} from './types.js';
import { getKilllist } from './client.js';
import type { KilllistItem } from './client.js';

// ---------------------------------------------------------------------------
// Defaults & limits
// ---------------------------------------------------------------------------

const DEFAULT_PAST_SECONDS: Record<string, number> = {
  system: 3600,
  character: 86400,
  corporation: 86400,
  alliance: 86400,
  ship_type: 7 * 86400,
};

const MAX_LIMIT = 50;
const MAX_DETAIL = 20;
const MIN_PAST_SECONDS = 3600;
const MAX_PAST_SECONDS = 30 * 86400; // 30 days (eve-kill has deeper history than zkill)

// ---------------------------------------------------------------------------
// Response fields for projection
// ---------------------------------------------------------------------------

export const KILL_FEED_RESPONSE_FIELDS = [
  'killmail_id',
  'time',
  'system',
  'system_sec',
  'region',
  'victim_name',
  'victim_corp',
  'victim_alliance',
  'victim_ship',
  'attacker_name',
  'attacker_corp',
  'attacker_ship',
  'attacker_weapon',
  'attackers_count',
  'value_m',
  'solo',
  'npc',
  'url',
] as const;

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type KillFeedResult = {
  ok: boolean;
  source: string;
  query: {
    scope: string;
    id: number;
    activity: string;
    past_seconds: number;
    limit: number;
  };
  total: number;
  killmails: CompactKill[];
  error: string | null;
};

export async function executeKillFeed(db: Db, rawArgs: Record<string, unknown>): Promise<KillFeedResult> {
  const args = normalizeArgs(rawArgs);

  // Build killlist params from scope
  const params = buildKilllistParams(args);
  const result = await getKilllist(db, params, cacheTtlForScope(args));

  if (!result.ok) {
    return {
      ok: false,
      source: 'eve-kill',
      query: buildQueryMeta(args),
      total: 0,
      killmails: [],
      error: result.error,
    };
  }

  const killmails = result.data.slice(0, args.detail_limit ?? 10);
  const compact = killmails.map(compactKilllistItem);

  // Apply field projection
  const projected = applyFieldProjection(compact, args.fields);

  return {
    ok: true,
    source: 'eve-kill',
    query: buildQueryMeta(args),
    total: result.data.length,
    killmails: projected,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Normalize raw args from model
// ---------------------------------------------------------------------------

function normalizeArgs(raw: Record<string, unknown>): KillFeedArgs {
  const scope = normalizeEnum(raw.scope, ['system', 'character', 'corporation', 'alliance', 'ship_type'], 'system');
  const id = normalizeInt(raw.id, 0);
  const activity = normalizeEnum<ActivityFilter>(raw.activity, ['kills', 'losses', 'all'], 'all');
  const pastSeconds = clamp(normalizeInt(raw.past_seconds, DEFAULT_PAST_SECONDS[scope] ?? 86400), MIN_PAST_SECONDS, MAX_PAST_SECONDS);
  const limit = clamp(normalizeInt(raw.limit, 10), 1, MAX_LIMIT);
  const detailLimit = clamp(normalizeInt(raw.detail_limit, Math.min(limit, 10)), 0, MAX_DETAIL);
  const fields = Array.isArray(raw.fields) ? raw.fields.filter((f): f is string => typeof f === 'string') : null;

  return { scope, id, activity, past_seconds: pastSeconds, limit, detail_limit: detailLimit, fields };
}

// ---------------------------------------------------------------------------
// Build /killlist query params from tool args
// ---------------------------------------------------------------------------

function buildKilllistParams(args: KillFeedArgs): Record<string, string | number> {
  const params: Record<string, string | number> = { limit: args.limit ?? 10 };

  switch (args.scope) {
    case 'system':
      params.system_id = args.id;
      break;
    case 'character':
      params.character_id = args.id;
      break;
    case 'corporation':
      params.corporation_id = args.id;
      break;
    case 'alliance':
      params.alliance_id = args.id;
      break;
    case 'ship_type':
      params.ship_type_id = args.id;
      break;
  }

  return params;
}

function cacheTtlForScope(args: KillFeedArgs): number {
  const pastSeconds = args.past_seconds ?? DEFAULT_PAST_SECONDS[args.scope] ?? 86400;
  return Math.max(60, Math.min(300, Math.floor(pastSeconds / 4)));
}

// ---------------------------------------------------------------------------
// Compact killlist item — token-efficient format for the model
// ---------------------------------------------------------------------------

function compactKilllistItem(km: KilllistItem): CompactKill {
  return {
    killmail_id: km.killmail_id,
    time: km.killmail_time ?? null,
    system: km.solar_system_name ?? null,
    system_sec: km.solar_system_security != null ? Math.round(km.solar_system_security * 10) / 10 : null,
    region: km.region_name ?? null,
    victim_name: km.victim_character_name ?? null,
    victim_corp: km.victim_corporation_name ?? null,
    victim_alliance: km.victim_alliance_name ?? null,
    victim_ship: km.ship_name ?? null,
    attacker_name: km.final_blow_character_name ?? null,
    attacker_corp: km.final_blow_corporation_name ?? null,
    attacker_ship: null, // killlist flat format doesn't include attacker ship
    attacker_weapon: null,
    attackers_count: km.attacker_count ?? 1,
    value_m: km.total_value ? Math.round(km.total_value / 1_000_000) : 0,
    solo: km.is_solo ?? false,
    npc: km.is_npc ?? false,
    url: `https://eve-kill.com/kill/${km.killmail_id}`,
  };
}

// ---------------------------------------------------------------------------
// Field projection
// ---------------------------------------------------------------------------

function applyFieldProjection(kills: CompactKill[], fields: string[] | null | undefined): CompactKill[] {
  if (!fields || fields.length === 0) return kills;
  const fieldSet = new Set(fields);
  return kills.map((kill) => {
    const filtered: Record<string, unknown> = {};
    for (const key of fieldSet) {
      if (key in kill) filtered[key] = (kill as Record<string, unknown>)[key];
    }
    return filtered as CompactKill;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildQueryMeta(args: KillFeedArgs) {
  return {
    scope: args.scope,
    id: args.id,
    activity: args.activity ?? 'all',
    past_seconds: args.past_seconds ?? 86400,
    limit: args.limit ?? 10,
  };
}

function normalizeInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

function normalizeEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? value as T : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
