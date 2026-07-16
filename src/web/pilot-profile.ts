import type { UserContext } from '../auth/user-resolver.js';
import type { Db } from '../db/sqlite.js';
import { getEveCapabilities } from '../eve/capabilities.js';
import { callEsiOperation, type EsiCallResult } from '../eve/esi-client.js';
import { getLinkedCharacter } from '../eve/sso.js';

export type ProfileAvailability = 'available' | 'missing_scope' | 'unavailable';

export type WebPilotProfile = {
  updatedAt: string;
  character: {
    id: number;
    name: string;
    portraitUrl: string;
    title: string | null;
    birthday: string | null;
    securityStatus: number | null;
  };
  corporation: { id: number; name: string; ticker: string | null } | null;
  alliance: { id: number; name: string; ticker: string | null } | null;
  online: boolean | null;
  location: { solarSystemId: number; solarSystemName: string | null; security: number | null } | null;
  ship: { typeId: number; typeName: string | null; name: string | null } | null;
  skills: { totalSp: number; queued: number; queueEndsAt: string | null } | null;
  wallet: { balance: number } | null;
  availability: {
    public: ProfileAvailability;
    online: ProfileAvailability;
    location: ProfileAvailability;
    ship: ProfileAvailability;
    skills: ProfileAvailability;
    wallet: ProfileAvailability;
  };
};

type ObjectData = Record<string, unknown>;

export async function loadWebPilotProfile(
  db: Db,
  ctx: UserContext,
): Promise<{ profile: WebPilotProfile | null; stale: boolean }> {
  const linked = getLinkedCharacter(db, ctx);
  if (!linked) return { profile: null, stale: false };

  const initialCharacterId = linked.characterId;
  const initialScopes = normalizeScopes(linked.scopes);
  const capabilities = await getEveCapabilities(db, 'web_pilot_profile', ctx);
  const allowed = new Set(capabilities.allowedNamespaces);

  const [publicResult, onlineResult, locationResult, shipResult, skillsResult, queueResult, walletResult] = await Promise.all([
    callEsiOperation<ObjectData>(db, 'get_characters_character_id', { character_id: initialCharacterId }, ctx),
    optionalCall<ObjectData>(allowed.has('esi_characters_online'), db, ctx, 'get_characters_character_id_online', initialCharacterId),
    optionalCall<ObjectData>(allowed.has('esi_characters_location'), db, ctx, 'get_characters_character_id_location', initialCharacterId),
    optionalCall<ObjectData>(allowed.has('esi_characters_ship'), db, ctx, 'get_characters_character_id_ship', initialCharacterId),
    optionalCall<ObjectData>(allowed.has('esi_characters_skills'), db, ctx, 'get_characters_character_id_skills', initialCharacterId),
    optionalCall<ObjectData[]>(allowed.has('esi_characters_skillqueue'), db, ctx, 'get_characters_character_id_skillqueue', initialCharacterId),
    optionalCall<number>(allowed.has('esi_characters_wallet'), db, ctx, 'get_characters_character_id_wallet', initialCharacterId),
  ]);

  const publicData = resultObject(publicResult);
  const corporationId = positiveInteger(publicData?.['corporation_id']);
  const allianceId = positiveInteger(publicData?.['alliance_id']);
  const [corporationResult, allianceResult] = await Promise.all([
    corporationId
      ? callEsiOperation<ObjectData>(db, 'get_corporations_corporation_id', { corporation_id: corporationId }, ctx)
      : Promise.resolve(null),
    allianceId
      ? callEsiOperation<ObjectData>(db, 'get_alliances_alliance_id', { alliance_id: allianceId }, ctx)
      : Promise.resolve(null),
  ]);

  const current = getLinkedCharacter(db, ctx);
  if (
    !current
    || current.characterId !== initialCharacterId
    || normalizeScopes(current.scopes) !== initialScopes
  ) {
    return { profile: null, stale: true };
  }

  const locationData = optionalObject(locationResult);
  const solarSystemId = positiveInteger(locationData?.['solar_system_id']);
  const shipData = optionalObject(shipResult);
  const shipTypeId = positiveInteger(shipData?.['ship_type_id']);
  const queueData = optionalArray(queueResult);
  const skillsData = optionalObject(skillsResult);
  const walletBalance = optionalNumber(walletResult);

  return {
    stale: false,
    profile: {
      updatedAt: new Date().toISOString(),
      character: {
        id: initialCharacterId,
        name: boundedString(publicData?.['name']) ?? linked.characterName,
        portraitUrl: `/api/web/profile/portrait`,
        title: boundedString(publicData?.['title']),
        birthday: isoString(publicData?.['birthday']),
        securityStatus: finiteNumber(publicData?.['security_status']),
      },
      corporation: corporationId
        ? organization(corporationId, corporationResult)
        : null,
      alliance: allianceId
        ? organization(allianceId, allianceResult)
        : null,
      online: optionalBoolean(onlineResult, 'online'),
      location: solarSystemId
        ? {
            solarSystemId,
            solarSystemName: lookupName(db, 'sde_systems', 'system_id', solarSystemId),
            security: lookupSystemSecurity(db, solarSystemId),
          }
        : null,
      ship: shipTypeId
        ? {
            typeId: shipTypeId,
            typeName: lookupName(db, 'sde_types', 'type_id', shipTypeId),
            name: boundedString(shipData?.['ship_name']),
          }
        : null,
      skills: skillsResult.enabled && skillsResult.result.ok
        ? {
            totalSp: finiteNumber(skillsData?.['total_sp']) ?? 0,
            queued: queueData?.length ?? 0,
            queueEndsAt: queueEnd(queueData),
          }
        : null,
      wallet: walletBalance === null ? null : { balance: walletBalance },
      availability: {
        public: publicResult.ok ? 'available' : 'unavailable',
        online: availability(onlineResult),
        location: availability(locationResult),
        ship: availability(shipResult),
        skills: availability(skillsResult),
        wallet: availability(walletResult),
      },
    },
  };
}

type OptionalResult<T> = { enabled: false } | { enabled: true; result: EsiCallResult<T> };

async function optionalCall<T>(
  enabled: boolean,
  db: Db,
  ctx: UserContext,
  operation: string,
  characterId: number,
): Promise<OptionalResult<T>> {
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    result: await callEsiOperation<T>(db, operation, { character_id: characterId }, ctx),
  };
}

function availability<T>(value: OptionalResult<T>): ProfileAvailability {
  if (!value.enabled) return 'missing_scope';
  return value.result.ok ? 'available' : 'unavailable';
}

function optionalObject(value: OptionalResult<ObjectData>): ObjectData | null {
  return value.enabled && value.result.ok && isObject(value.result.data) ? value.result.data : null;
}

function optionalArray(value: OptionalResult<ObjectData[]>): ObjectData[] | null {
  return value.enabled && value.result.ok && Array.isArray(value.result.data) ? value.result.data : null;
}

function optionalNumber(value: OptionalResult<number>): number | null {
  return value.enabled && value.result.ok ? finiteNumber(value.result.data) : null;
}

function optionalBoolean(value: OptionalResult<ObjectData>, key: string): boolean | null {
  const data = optionalObject(value);
  return typeof data?.[key] === 'boolean' ? data[key] : null;
}

function resultObject(value: EsiCallResult<ObjectData>): ObjectData | null {
  return value.ok && isObject(value.data) ? value.data : null;
}

function organization(
  id: number,
  result: EsiCallResult<ObjectData> | null,
): { id: number; name: string; ticker: string | null } | null {
  if (!result?.ok || !isObject(result.data)) return null;
  const name = boundedString(result.data['name']);
  if (!name) return null;
  return { id, name, ticker: boundedString(result.data['ticker'], 32) };
}

function queueEnd(queue: ObjectData[] | null): string | null {
  if (!queue) return null;
  let latest = 0;
  let value: string | null = null;
  for (const entry of queue) {
    const finish = isoString(entry['finish_date']);
    if (!finish) continue;
    const timestamp = Date.parse(finish);
    if (Number.isFinite(timestamp) && timestamp > latest) {
      latest = timestamp;
      value = finish;
    }
  }
  return value;
}

function lookupName(db: Db, table: 'sde_systems' | 'sde_types', idColumn: 'system_id' | 'type_id', id: number): string | null {
  const row = db.prepare(`SELECT name FROM ${table} WHERE ${idColumn} = ?`).get(id) as { name: string } | undefined;
  return boundedString(row?.name);
}

function lookupSystemSecurity(db: Db, systemId: number): number | null {
  const row = db.prepare(`
    SELECT json_extract(data_json, '$.securityStatus') AS value
    FROM sde_systems WHERE system_id = ?
  `).get(systemId) as { value: number | null } | undefined;
  return finiteNumber(row?.value);
}

function normalizeScopes(scopes: string[]): string {
  return JSON.stringify([...new Set(scopes)].sort());
}

function boundedString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function isoString(value: unknown): string | null {
  const text = boundedString(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isObject(value: unknown): value is ObjectData {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
