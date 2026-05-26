/**
 * kill_intel tool execution — stats, tops, battles, coalition, search, prices.
 */

import type { Db } from '../db/sqlite.js';
import type { KillIntelArgs, KillIntelAction, KillIntelScope } from './types.js';
import {
  getEntityStats,
  getEntityShortStats,
  getEntityTop,
  getEntityBattles,
  getEntityDetail,
  getCharacterCorpHistory,
  getCorpAllianceHistory,
  getEntityMembers,
  getAllianceCoalition,
  getAllianceCorporations,
  listBattles,
  getBattle,
  getKillmail,
  getKillmailBatch,
  getKillmailSibling,
  getBuildPrice,
  getTypePrices,
  getWar,
  getWarKillmails,
  getFaction,
  search,
  getGlobalStats,
  getKillmailNearCelestial,
  getKillmailNearCoordinates,
} from './client.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type KillIntelResult = {
  ok: boolean;
  source: string;
  action: string;
  data: unknown;
  error: string | null;
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function executeKillIntel(db: Db, rawArgs: Record<string, unknown>): Promise<KillIntelResult> {
  const args = normalizeArgs(rawArgs);

  try {
    const data = await dispatch(db, args);
    return { ok: true, source: 'eve-kill', action: args.action, data, error: null };
  } catch (err) {
    return { ok: false, source: 'eve-kill', action: args.action, data: null, error: (err as Error).message };
  }
}

async function dispatch(db: Db, args: KillIntelArgs): Promise<unknown> {
  const scopePlural = args.scope ? `${args.scope}s` as const : null;

  switch (args.action) {
    case 'stats': {
      requireScopeAndId(args);
      const r = await getEntityStats(db, scopePlural!, args.id!, args.days ?? 7);
      return unwrap(r);
    }
    case 'shortstats': {
      requireScopeAndId(args);
      const r = await getEntityShortStats(db, scopePlural!, args.id!, args.days ?? 7);
      return unwrap(r);
    }
    case 'top': {
      requireScopeAndId(args);
      const topType = args.top_type ?? 'ships';
      const r = await getEntityTop(db, scopePlural!, args.id!, topType);
      return unwrap(r);
    }
    case 'battles': {
      if (args.scope && args.id) {
        const r = await getEntityBattles(db, scopePlural!, args.id, 1, args.limit ?? 10);
        return unwrap(r);
      }
      const r = await listBattles(db, 1, args.limit ?? 10);
      return unwrap(r);
    }
    case 'battle_detail': {
      const battleId = args.battle_id ?? args.id;
      if (!battleId) throw new Error('battle_detail requires battle_id or id');
      const r = await getBattle(db, battleId, true);
      return unwrap(r);
    }
    case 'coalition': {
      if (!args.id) throw new Error('coalition requires alliance id');
      const r = await getAllianceCoalition(db, args.id);
      return unwrap(r);
    }
    case 'corp_history': {
      if (!args.id) throw new Error('corp_history requires character id');
      const r = await getCharacterCorpHistory(db, args.id);
      return unwrap(r);
    }
    case 'alliance_history': {
      if (!args.id) throw new Error('alliance_history requires corporation id');
      const r = await getCorpAllianceHistory(db, args.id);
      return unwrap(r);
    }
    case 'members': {
      if (!args.scope || !args.id) throw new Error('members requires scope (corporation/alliance) and id');
      if (args.scope === 'character') throw new Error('members not available for characters');
      const r = await getEntityMembers(db, scopePlural! as 'corporations' | 'alliances', args.id, 1, args.limit ?? 100);
      return unwrap(r);
    }
    case 'search': {
      if (!args.search_term) throw new Error('search requires search_term');
      const r = await search(db, args.search_term);
      return unwrap(r);
    }
    case 'build_price': {
      if (!args.type_id) throw new Error('build_price requires type_id');
      const r = await getBuildPrice(db, args.type_id, args.days ?? 7);
      return unwrap(r);
    }
    case 'global_stats': {
      const validTypes = [
        'characters', 'corporations', 'alliances', 'solarsystems', 'constellations',
        'regions', 'ships', 'solo', 'most_valuable_kills', 'most_valuable_structures',
        'most_valuable_ships', 'kill_count', 'new_characters',
      ];
      const type = typeof args.top_type === 'string' && validTypes.includes(args.top_type)
        ? args.top_type
        : 'most_valuable_kills';
      const r = await getGlobalStats(db, type, args.days ?? 7, args.limit ?? 10);
      return unwrap(r);
    }
    case 'near_celestial': {
      if (!args.celestial_id) throw new Error('near_celestial requires celestial_id');
      const r = await getKillmailNearCelestial(
        db,
        args.celestial_id,
        args.distance_meters ?? 100_000,
        args.days ?? 7,
      );
      return unwrap(r);
    }
    case 'near_coordinates': {
      if (!args.id) throw new Error('near_coordinates requires system_id as id');
      const r = await getKillmailNearCoordinates(
        db, args.id,
        args.x ?? 0, args.y ?? 0, args.z ?? 0,
        args.distance_meters ?? 100_000,
        args.days ?? 7,
        args.limit ?? 50,
      );
      return unwrap(r);
    }
    case 'killmail': {
      if (!args.id) throw new Error('killmail requires killmail id');
      const r = await getKillmail(db, args.id);
      return unwrap(r);
    }
    case 'killmail_batch': {
      if (!Array.isArray(args.ids) || args.ids.length === 0) throw new Error('killmail_batch requires ids array');
      const r = await getKillmailBatch(db, args.ids.filter((v): v is number => typeof v === 'number'));
      return unwrap(r);
    }
    case 'killmail_sibling': {
      if (!args.id) throw new Error('killmail_sibling requires killmail id');
      const r = await getKillmailSibling(db, args.id);
      return unwrap(r);
    }
    case 'entity_detail': {
      requireScopeAndId(args);
      const r = await getEntityDetail(db, scopePlural!, args.id!);
      return unwrap(r);
    }
    case 'alliance_corps': {
      if (!args.id) throw new Error('alliance_corps requires alliance id');
      const r = await getAllianceCorporations(db, args.id, 1, args.limit ?? 100);
      return unwrap(r);
    }
    case 'war': {
      if (!args.id) throw new Error('war requires war id');
      const r = await getWar(db, args.id);
      return unwrap(r);
    }
    case 'war_killmails': {
      if (!args.id) throw new Error('war_killmails requires war id');
      const r = await getWarKillmails(db, args.id);
      return unwrap(r);
    }
    case 'faction': {
      if (!args.id) throw new Error('faction requires faction id');
      const r = await getFaction(db, args.id);
      return unwrap(r);
    }
    case 'type_prices': {
      if (!args.type_id) throw new Error('type_prices requires type_id');
      const r = await getTypePrices(db, args.type_id, args.days ?? 7);
      return unwrap(r);
    }
    default:
      throw new Error(`Unknown kill_intel action: ${args.action}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireScopeAndId(args: KillIntelArgs): asserts args is KillIntelArgs & { scope: KillIntelScope; id: number } {
  if (!args.scope) throw new Error(`${args.action} requires scope (character/corporation/alliance)`);
  if (!args.id) throw new Error(`${args.action} requires entity id`);
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function normalizeArgs(raw: Record<string, unknown>): KillIntelArgs {
  return {
    action: typeof raw.action === 'string' ? raw.action as KillIntelAction : 'stats',
    scope: normalizeEnum<KillIntelScope>(raw.scope, ['character', 'corporation', 'alliance']),
    id: normalizeOptionalInt(raw.id),
    top_type: normalizeEnum<'ships' | 'systems' | 'regions'>(raw.top_type, ['ships', 'systems', 'regions']),
    days: typeof raw.days === 'number' ? Math.max(0, Math.trunc(raw.days)) : 7,
    limit: typeof raw.limit === 'number' ? Math.max(1, Math.min(100, Math.trunc(raw.limit))) : 10,
    search_term: typeof raw.search_term === 'string' ? raw.search_term : null,
    type_id: normalizeOptionalInt(raw.type_id),
    celestial_id: normalizeOptionalInt(raw.celestial_id),
    distance_meters: normalizeOptionalInt(raw.distance_meters),
    battle_id: raw.battle_id != null ? raw.battle_id as number | string : null,
    x: normalizeOptionalNum(raw.x),
    y: normalizeOptionalNum(raw.y),
    z: normalizeOptionalNum(raw.z),
    ids: Array.isArray(raw.ids) ? raw.ids.filter((v): v is number => typeof v === 'number') : null,
  };
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : null;
}

function normalizeOptionalInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function normalizeOptionalNum(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
