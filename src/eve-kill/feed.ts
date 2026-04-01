/**
 * kill_feed tool execution — recent kills by system, entity, or ship type.
 */

import type { Db } from '../db/sqlite.js';
import type {
  KillFeedArgs,
  CompactKill,
  EveKillKillmail,
  ActivityFilter,
} from './types.js';
import { queryKillmails } from './client.js';
import { buildFeedQuery } from './query.js';

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

  const queryReq = buildFeedQuery(
    args.scope,
    args.id,
    args.activity ?? 'all',
    args.past_seconds ?? DEFAULT_PAST_SECONDS[args.scope] ?? 86400,
    args.limit ?? 10,
  );

  const result = await queryKillmails(db, queryReq);

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
  const compact = killmails.map(compactKillmail);

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
// Compact killmail — token-efficient format for the model
// ---------------------------------------------------------------------------

function compactKillmail(km: EveKillKillmail): CompactKill {
  const victim = km.victim ?? {};
  const attackers = km.attackers ?? [];
  const finalBlow = attackers.find((a) => a.final_blow) ?? attackers[0];

  return {
    killmail_id: km.killmail_id,
    time: km.kill_time ?? null,
    system: km.system_name ?? null,
    system_sec: km.system_security != null ? Math.round(km.system_security * 10) / 10 : null,
    region: km.region_name ?? null,
    victim_name: victim.character_name ?? null,
    victim_corp: victim.corporation_name ?? null,
    victim_alliance: victim.alliance_name ?? null,
    victim_ship: victim.ship_name ?? null,
    attacker_name: finalBlow?.character_name ?? null,
    attacker_corp: finalBlow?.corporation_name ?? null,
    attacker_ship: finalBlow?.ship_name ?? null,
    attacker_weapon: finalBlow?.weapon_name ?? null,
    attackers_count: attackers.length,
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
