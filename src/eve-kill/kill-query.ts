/**
 * kill_query tool execution — advanced MongoDB-style killmail searches.
 */

import type { Db } from '../db/sqlite.js';
import type { KillQueryArgs, CompactKill, EveKillKillmail } from './types.js';
import { queryKillmails } from './client.js';
import { sanitizeUserFilter } from './query.js';
import { KILL_FEED_RESPONSE_FIELDS } from './feed.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type KillQueryResult = {
  ok: boolean;
  source: string;
  total: number;
  killmails: CompactKill[];
  error: string | null;
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function executeKillQuery(db: Db, rawArgs: Record<string, unknown>): Promise<KillQueryResult> {
  const args = normalizeArgs(rawArgs);
  const filter = sanitizeUserFilter(args.filter);

  if (Object.keys(filter).length === 0) {
    return { ok: false, source: 'eve-kill', total: 0, killmails: [], error: 'Empty or invalid filter. Provide at least one filter condition.' };
  }

  const result = await queryKillmails(db, {
    filter,
    options: {
      limit: args.limit ?? 20,
      sort: args.sort ?? { kill_time: -1 },
    },
  });

  if (!result.ok) {
    return { ok: false, source: 'eve-kill', total: 0, killmails: [], error: result.error };
  }

  const compact = result.data.map(compactKillmail);
  const projected = applyFieldProjection(compact, args.fields);

  return {
    ok: true,
    source: 'eve-kill',
    total: result.data.length,
    killmails: projected,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Compact killmail
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
// Normalize
// ---------------------------------------------------------------------------

function normalizeArgs(raw: Record<string, unknown>): KillQueryArgs {
  // filter arrives as JSON string (strict mode) or object (fallback)
  const filter = parseJsonParam<Record<string, unknown>>(raw.filter, {});
  // sort arrives as JSON string or object
  const sort = parseJsonParam<Record<string, 1 | -1> | null>(raw.sort, null);

  const limit = typeof raw.limit === 'number' ? Math.max(1, Math.min(100, Math.trunc(raw.limit))) : 20;

  const fields = Array.isArray(raw.fields)
    ? raw.fields.filter((f): f is string => typeof f === 'string' && (KILL_FEED_RESPONSE_FIELDS as readonly string[]).includes(f))
    : null;

  return { filter, sort, limit, fields };
}

function parseJsonParam<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as T;
  }
  return fallback;
}
