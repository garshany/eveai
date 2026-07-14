import type { Db } from '../db/sqlite.js';
import { searchKillmails } from '../eve-kill/client.js';
import type { KillmailSearchRequest, KillmailEntity, NormalizedKillmail } from '../eve-kill/types.js';
import type { OsintActivityResult, OsintKillmail, OsintScope } from './types.js';

const MAX_OSINT_KILLS = 500;

export async function fetchEntityActivityHistory(
  db: Db,
  args: { scope: OsintScope; id: number; from: string; to: string },
): Promise<{ ok: true; data: OsintActivityResult } | { ok: false; error: string }> {
  const request: KillmailSearchRequest = {
    from: args.from,
    to: args.to,
    [filterKey(args.scope)]: [args.id],
  };
  const result = await searchKillmails(db, request, { limit: MAX_OSINT_KILLS });
  if (!result.ok) return result;

  return {
    ok: true,
    data: {
      kills: result.data.kills
        .map((kill) => normalizeForAnalysis(kill, args.scope, args.id))
        .filter((kill): kill is OsintKillmail => kill !== null),
      truncated: result.data.truncated,
      requestCount: result.data.requestCount,
      windows: result.data.windows,
    },
  };
}

function filterKey(scope: OsintScope): 'character_ids' | 'corporation_ids' | 'alliance_ids' {
  if (scope === 'character') return 'character_ids';
  if (scope === 'corporation') return 'corporation_ids';
  return 'alliance_ids';
}

function normalizeForAnalysis(
  kill: NormalizedKillmail,
  scope: OsintScope,
  id: number,
): OsintKillmail | null {
  const victim = matchesEntity(kill.victim, scope, id);
  const attacker = kill.attackers.some((entity) => matchesEntity(entity, scope, id));
  if (!victim && !attacker) return null;

  return {
    roles: { attacker, victim },
    killmail_id: kill.killmailId,
    ...(kill.killmailTime ? { killmail_time: kill.killmailTime } : {}),
    ...(kill.solarSystemId !== undefined ? { solar_system_id: kill.solarSystemId } : {}),
    ...(kill.totalValue !== undefined ? { total_value: kill.totalValue } : {}),
    attacker_count: kill.attackerCount,
    ...(kill.isNpc !== undefined ? { is_npc: kill.isNpc } : {}),
    ...(kill.isSolo !== undefined ? { is_solo: kill.isSolo } : {}),
    ...(kill.victim.shipTypeId !== undefined ? { ship_type_id: kill.victim.shipTypeId } : {}),
    ...(kill.victim.characterId !== undefined ? { victim_character_id: kill.victim.characterId } : {}),
    ...(kill.victim.corporationId !== undefined ? { victim_corporation_id: kill.victim.corporationId } : {}),
    ...(kill.victim.allianceId !== undefined ? { victim_alliance_id: kill.victim.allianceId } : {}),
    attackers: kill.attackers.map((entity) => ({
      ...(entity.characterId !== undefined ? { character_id: entity.characterId } : {}),
      ...(entity.corporationId !== undefined ? { corporation_id: entity.corporationId } : {}),
      ...(entity.allianceId !== undefined ? { alliance_id: entity.allianceId } : {}),
      ...(entity.shipTypeId !== undefined ? { ship_type_id: entity.shipTypeId } : {}),
      ...(entity.weaponTypeId !== undefined ? { weapon_type_id: entity.weaponTypeId } : {}),
      ...(entity.finalBlow !== undefined ? { final_blow: entity.finalBlow } : {}),
    })),
  };
}

function matchesEntity(entity: KillmailEntity, scope: OsintScope, id: number): boolean {
  if (scope === 'character') return entity.characterId === id;
  if (scope === 'corporation') return entity.corporationId === id;
  return entity.allianceId === id;
}
