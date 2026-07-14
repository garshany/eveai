import type { Db } from '../db/sqlite.js';
import {
  getBattle,
  getCharacterIntel,
  getCharacterStats,
  getKillmailDetail,
  getKillmailEsi,
  getKillmailFitting,
  getLeaderboard,
  listBattles,
  listEntityActivity,
  listSystemKills,
  searchKillmails,
} from './client.js';
import type { KillmailSearchRequest, NormalizedKillmail, SearchFilterKey } from './types.js';
import type { EveKillToolName } from './tools.js';
import { addWatch, listWatches, removeAllWatches, removeWatch } from './watch.js';

export async function executeEveKillTool(
  db: Db,
  name: EveKillToolName,
  args: Record<string, unknown>,
  chatId?: number,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'kill_search': return await executeSearch(db, args);
    case 'kill_activity': return await executeActivity(db, args);
    case 'kill_detail': return await executeDetail(db, args);
    case 'kill_intel': return await executeIntel(db, args);
    case 'kill_battles': return await executeBattles(db, args);
    case 'kill_watch': return executeWatch(db, args, chatId);
  }
}

async function executeSearch(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const request: KillmailSearchRequest = {
    from: requiredString(args.from, 'from'),
    to: requiredString(args.to, 'to'),
  };
  for (const key of ['system_ids', 'constellation_ids', 'region_ids', 'character_ids', 'corporation_ids', 'alliance_ids'] as SearchFilterKey[]) {
    const ids = optionalIds(args[key], key);
    if (ids.length > 0) request[key] = ids;
  }
  return provenanceSearch(await searchKillmails(db, request, { limit: toolResultLimit(args.limit) }));
}

async function executeActivity(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const scope = requiredEnum(args.scope, ['system', 'character', 'corporation', 'alliance'] as const, 'scope');
  const id = requiredInt(args.id, 'id');
  const activity = requiredEnum(args.activity, ['kills', 'losses', 'all'] as const, 'activity');
  if (scope === 'system' && activity !== 'all') {
    throw new Error('system activity does not have separate kills/losses roles; use activity=all');
  }
  const options = {
    from: optionalString(args.from),
    to: optionalString(args.to),
    limit: toolResultLimit(args.limit),
  };
  const result = scope === 'system'
    ? await listSystemKills(db, id, options)
    : await listEntityActivity(db, scope, id, activity, options);
  return provenanceSearch(result);
}

async function executeDetail(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = requiredEnum(args.action, ['detail', 'fitting', 'hash_discovery'] as const, 'action');
  const id = requiredInt(args.killmail_id, 'killmail_id');
  if (action === 'fitting') return provenance(await getKillmailFitting(db, id));
  if (action === 'hash_discovery') {
    const result = await getKillmailEsi(db, id);
    if (!result.ok) return provenance(result);
    return provenance({ ok: true, data: {
      killmail_id: result.data.killmailId,
      killmail_hash: result.data.killmailHash ?? null,
    } }, 'ID-only EVE-KILL discovery is non-authoritative; use CCP ESI with the discovered (id, hash) for official detail.');
  }
  const result = await getKillmailDetail(db, id);
  if (!result.ok) return provenance(result);
  return provenance({ ok: true, data: projectKill(result.data, true) });
}

async function executeIntel(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = requiredEnum(args.action, ['character_stats', 'character_intel', 'leaderboard'] as const, 'action');
  if (action === 'character_stats') {
    const period = args.period === 'weekly' ? 'weekly' : 'alltime';
    return provenance(await getCharacterStats(db, requiredInt(args.character_id, 'character_id'), { type: period }));
  }
  if (action === 'character_intel') {
    return provenance(await getCharacterIntel(
      db,
      requiredInt(args.character_id, 'character_id'),
      optionalInt(args.days) ?? 365,
    ));
  }
  return provenance(await getLeaderboard(
    db,
    requiredString(args.data_type, 'data_type'),
    optionalInt(args.days) ?? 7,
    optionalInt(args.limit) ?? 10,
  ));
}

async function executeBattles(db: Db, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = requiredEnum(args.action, ['list', 'detail'] as const, 'action');
  if (action === 'detail') {
    return provenance(await getBattle(
      db,
      requiredInt(args.battle_id, 'battle_id'),
      optionalInt(args.limit) ?? 100,
    ));
  }
  const sort = args.sort === 'total_isk_destroyed' || args.sort === 'kill_count' || args.sort === 'start_time'
    ? args.sort
    : 'battle_id';
  return provenance(await listBattles(db, {
    page: optionalInt(args.page),
    limit: optionalInt(args.limit),
    sort,
  }));
}

function executeWatch(db: Db, args: Record<string, unknown>, chatId?: number): Record<string, unknown> {
  if (chatId === undefined) return { ok: false, source: 'EVE-KILL', error: 'Kill watch requires a chat context.' };
  const action = requiredEnum(args.action, ['watch', 'unwatch', 'unwatch_all', 'list'] as const, 'action');
  if (action === 'list') return { ok: true, source: 'EVE-KILL', data: listWatches(db, chatId) };
  if (action === 'unwatch_all') return { ok: true, source: 'EVE-KILL', removed: removeAllWatches(db, chatId) };
  const topicType = requiredEnum(args.topic_type, ['victim', 'attacker', 'system', 'region'] as const, 'topic_type');
  const topic = `${topicType}.${requiredInt(args.topic_id, 'topic_id')}`;
  const result = action === 'watch'
    ? addWatch(db, chatId, topic, optionalString(args.label) ?? '')
    : removeWatch(db, chatId, topic);
  return { ...result, source: 'EVE-KILL', topic };
}

function provenance<T>(
  result: { ok: true; data: T } | { ok: false; error: string; status?: number },
  limitation = 'Third-party public EVE-KILL observation; coverage may be incomplete.',
): Record<string, unknown> {
  return result.ok
    ? { ok: true, source: 'EVE-KILL', authoritative: false, limitation, data: result.data }
    : { ok: false, source: 'EVE-KILL', error: result.error, status: result.status };
}

function provenanceSearch(
  result: { ok: true; data: { kills: NormalizedKillmail[]; truncated: boolean; requestCount: number; windows: Array<{ from: string; to: string }> } }
    | { ok: false; error: string; status?: number },
): Record<string, unknown> {
  if (!result.ok) return provenance(result);
  return provenance({ ok: true, data: {
    ...result.data,
    kills: result.data.kills.map((kill) => projectKill(kill, false)),
  } });
}

function projectKill(kill: NormalizedKillmail, detail: boolean): Record<string, unknown> {
  const attackerLimit = detail ? 100 : 20;
  const itemLimit = detail ? 200 : 0;
  const siblingLimit = detail ? 20 : 0;
  return {
    killmail_id: kill.killmailId,
    killmail_hash: kill.killmailHash ?? null,
    killmail_time: kill.killmailTime ?? null,
    solar_system_id: kill.solarSystemId ?? null,
    solar_system_name: kill.solarSystemName ?? null,
    region_id: kill.regionId ?? null,
    region_name: kill.regionName ?? null,
    total_value: kill.totalValue ?? null,
    attacker_count: kill.attackerCount,
    is_npc: kill.isNpc ?? null,
    is_solo: kill.isSolo ?? null,
    activity: kill.activity ?? null,
    victim: projectEntity(kill.victim),
    attackers: kill.attackers.slice(0, attackerLimit).map(projectEntity),
    position: kill.position ?? null,
    ...(detail ? {
      fitted_value: kill.fittedValue ?? null,
      dropped_value: kill.droppedValue ?? null,
      destroyed_value: kill.destroyedValue ?? null,
      points: kill.points ?? null,
      items: kill.items.slice(0, itemLimit),
      siblings: kill.siblings.slice(0, siblingLimit).map((sibling) => ({
        killmail_id: sibling.killmailId,
        killmail_time: sibling.killmailTime ?? null,
        solar_system_id: sibling.solarSystemId ?? null,
        total_value: sibling.totalValue ?? null,
      })),
    } : {}),
    truncated: {
      attackers: kill.attackers.length > attackerLimit,
      items: kill.items.length > itemLimit,
      siblings: kill.siblings.length > siblingLimit,
    },
  };
}

function projectEntity(entity: NormalizedKillmail['victim']): Record<string, unknown> {
  return {
    character_id: entity.characterId ?? null,
    corporation_id: entity.corporationId ?? null,
    alliance_id: entity.allianceId ?? null,
    faction_id: entity.factionId ?? null,
    character_name: entity.characterName ?? null,
    corporation_name: entity.corporationName ?? null,
    alliance_name: entity.allianceName ?? null,
    ship_type_id: entity.shipTypeId ?? null,
    ship_name: entity.shipName ?? null,
    weapon_type_id: entity.weaponTypeId ?? null,
    weapon_name: entity.weaponName ?? null,
    damage_done: entity.damageDone ?? null,
    damage_taken: entity.damageTaken ?? null,
    final_blow: entity.finalBlow ?? null,
  };
}

function requiredInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function toolResultLimit(value: unknown): number {
  return Math.max(1, Math.min(100, optionalInt(value) ?? 25));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalIds(value: unknown, name: string): number[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error(`${name} must contain only positive integer IDs`);
  }
  return [...new Set(value as number[])];
}

function requiredEnum<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Error(`invalid ${name}`);
  return value as T[number];
}
