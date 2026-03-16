import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { callEsiOperation, type EsiCallResult } from './esi-client.js';
import { getEveCapabilities } from './capabilities.js';
import { getLinkedCharacter } from './sso.js';

type JsonResult<T> = { ok: true; data: T } | { ok: false; error: string };

export function readUserProfile(db: Db, chatId?: number): string | null {
  const characterId = getLinkedCharacter(db, chatId)?.characterId ?? null;
  if (!characterId) return null;
  const path = resolveUserProfilePath(characterId);
  if (existsSync(path)) {
    const content = readFileSync(path, 'utf-8').trim();
    if (content.length > 0) return content;
  }
  return null;
}

export async function refreshUserProfile(db: Db, chatId?: number): Promise<JsonResult<{ path: string }>> {
  const capabilities = await getEveCapabilities(db, 'user_profile', chatId);
  if (!capabilities.authenticated || !capabilities.characterId || !capabilities.characterName) {
    return { ok: false, error: 'No authenticated character available.' };
  }

  const characterId = capabilities.characterId;
  const characterName = capabilities.characterName;

  const baseInfo = await runEsiJson<Record<string, unknown>>(db, chatId, 'get_characters_character_id', {
    character_id: characterId,
  });

  const online = capabilities.allowedNamespaces.includes('esi_characters_online')
    ? await runEsiJson<Record<string, unknown>>(db, chatId, 'get_characters_character_id_online', {
      character_id: characterId,
    })
    : null;

  const location = capabilities.allowedNamespaces.includes('esi_characters_location')
    ? await runEsiJson<Record<string, unknown>>(db, chatId, 'get_characters_character_id_location', {
      character_id: characterId,
    })
    : null;

  const ship = capabilities.allowedNamespaces.includes('esi_characters_ship')
    ? await runEsiJson<Record<string, unknown>>(db, chatId, 'get_characters_character_id_ship', {
      character_id: characterId,
    })
    : null;

  const skills = capabilities.allowedNamespaces.includes('esi_characters_skills')
    ? await runEsiJson<Record<string, unknown>>(db, chatId, 'get_characters_character_id_skills', {
      character_id: characterId,
    })
    : null;

  const wallet = capabilities.allowedNamespaces.includes('esi_characters_wallet')
    ? await runEsiJson<number>(db, chatId, 'get_characters_character_id_wallet', {
      character_id: characterId,
    })
    : null;

  const corporationId = extractNumber(baseInfo, 'corporation_id');
  const allianceId = extractNumber(baseInfo, 'alliance_id');
  const factionId = extractNumber(baseInfo, 'faction_id');

  const corporation = corporationId
    ? await runEsiJson<Record<string, unknown>>(db, chatId, 'get_corporations_corporation_id', {
      corporation_id: corporationId,
    })
    : null;

  const alliance = allianceId
    ? await runEsiJson<Record<string, unknown>>(db, chatId, 'get_alliances_alliance_id', {
      alliance_id: allianceId,
    })
    : null;

  const factionName = factionId
    ? await resolveFactionName(db, chatId, factionId)
    : null;

  const systemId = extractNumber(location, 'solar_system_id');
  const stationId = extractNumber(location, 'station_id');
  const structureId = extractNumber(location, 'structure_id');

  const shipTypeId = extractNumber(ship, 'ship_type_id');

  const markdown = buildUserMarkdown({
    updatedAt: new Date().toISOString(),
    character: {
      name: characterName,
      id: characterId,
      birthday: extractString(baseInfo, 'birthday'),
      securityStatus: extractNumber(baseInfo, 'security_status'),
      corporationId,
      corporationName: extractString(corporation, 'name'),
      allianceId,
      allianceName: extractString(alliance, 'name'),
      factionId,
      factionName,
    },
    status: {
      isOnline: extractBoolean(online, 'online'),
      lastLogin: extractString(online, 'last_login'),
      lastLogout: extractString(online, 'last_logout'),
      systemId,
      systemName: lookupSdeName(db, 'sde_systems', 'system_id', systemId),
      stationId,
      stationName: lookupSdeName(db, 'sde_stations', 'station_id', stationId),
      structureId,
      shipName: extractString(ship, 'ship_name'),
      shipTypeId,
      shipTypeName: lookupSdeName(db, 'sde_types', 'type_id', shipTypeId),
    },
    skills: {
      totalSp: extractNumber(skills, 'total_sp'),
      unallocatedSp: extractNumber(skills, 'unallocated_sp'),
    },
    wallet: {
      balance: wallet && wallet.ok ? wallet.data : null,
    },
  });

  const path = resolveUserProfilePath(characterId);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, markdown);
  return { ok: true, data: { path } };
}

function resolveUserProfilePath(characterId: number): string {
  const base = config.userProfile.path;
  if (base.includes('{character_id}')) {
    return base.replace('{character_id}', String(characterId));
  }
  const dir = dirname(base);
  return join(dir, `USER_${characterId}.md`);
}

async function runEsiJson<T>(
  db: Db,
  chatId: number | undefined,
  operationName: string,
  args: Record<string, unknown>,
): Promise<JsonResult<T>> {
  const result = await callEsiOperation<T>(db, operationName, args, chatId);

  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Unknown ESI error' };
  }
  return { ok: true, data: result.data };
}

function extractString(source: JsonResult<Record<string, unknown>> | null, key: string): string | null {
  if (!source || !source.ok) return null;
  const value = source.data[key];
  return typeof value === 'string' ? value : null;
}

function extractNumber(source: JsonResult<Record<string, unknown>> | null, key: string): number | null {
  if (!source || !source.ok) return null;
  const value = source.data[key];
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function extractBoolean(source: JsonResult<Record<string, unknown>> | null, key: string): boolean | null {
  if (!source || !source.ok) return null;
  const value = source.data[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function lookupSdeName(
  db: Db,
  table: string,
  idCol: string,
  id: number | null,
): string | null {
  if (!id) return null;
  try {
    const row = db.prepare(`SELECT name FROM ${table} WHERE ${idCol} = ?`).get(id) as { name: string } | undefined;
    return row?.name ?? null;
  } catch {
    return null;
  }
}

async function resolveFactionName(db: Db, chatId: number | undefined, factionId: number): Promise<string | null> {
  const result = await runEsiJson<Record<string, unknown>[]>(db, chatId, 'get_universe_factions', {});
  if (!result.ok) return null;
  for (const entry of result.data) {
    if (Number(entry['faction_id']) === factionId && typeof entry['name'] === 'string') {
      return entry['name'] as string;
    }
  }
  return null;
}

type UserProfileData = {
  updatedAt: string;
  character: {
    name: string;
    id: number;
    birthday: string | null;
    securityStatus: number | null;
    corporationId: number | null;
    corporationName: string | null;
    allianceId: number | null;
    allianceName: string | null;
    factionId: number | null;
    factionName: string | null;
  };
  status: {
    isOnline: boolean | null;
    lastLogin: string | null;
    lastLogout: string | null;
    systemId: number | null;
    systemName: string | null;
    stationId: number | null;
    stationName: string | null;
    structureId: number | null;
    shipName: string | null;
    shipTypeId: number | null;
    shipTypeName: string | null;
  };
  skills: {
    totalSp: number | null;
    unallocatedSp: number | null;
  };
  wallet: {
    balance: number | null;
  };
};

function buildUserMarkdown(profile: UserProfileData): string {
  const lines: string[] = [];
  lines.push('# User Profile');
  lines.push(`Updated: ${profile.updatedAt}`);
  lines.push('');
  lines.push('## Character');
  lines.push(`- Name: ${profile.character.name}`);
  lines.push(`- ID: ${profile.character.id}`);
  addLine(lines, 'Birthday', profile.character.birthday);
  addLine(lines, 'Security status', formatNumber(profile.character.securityStatus));
  addLine(lines, 'Corporation', formatNameWithId(profile.character.corporationName, profile.character.corporationId));
  addLine(lines, 'Alliance', formatNameWithId(profile.character.allianceName, profile.character.allianceId));
  addLine(lines, 'Faction', formatNameWithId(profile.character.factionName, profile.character.factionId));

  lines.push('');
  lines.push('## Status');
  addLine(lines, 'Online', profile.status.isOnline === null ? null : (profile.status.isOnline ? 'yes' : 'no'));
  addLine(lines, 'Last login', profile.status.lastLogin);
  addLine(lines, 'Last logout', profile.status.lastLogout);
  addLine(lines, 'System', formatNameWithId(profile.status.systemName, profile.status.systemId));
  addLine(lines, 'Station', formatNameWithId(profile.status.stationName, profile.status.stationId));
  addLine(lines, 'Structure ID', profile.status.structureId ? String(profile.status.structureId) : null);
  addLine(lines, 'Ship', formatShip(profile.status.shipName, profile.status.shipTypeName, profile.status.shipTypeId));

  lines.push('');
  lines.push('## Skills');
  addLine(lines, 'Total SP', formatNumber(profile.skills.totalSp));
  addLine(lines, 'Unallocated SP', formatNumber(profile.skills.unallocatedSp));

  lines.push('');
  lines.push('## Wallet');
  addLine(lines, 'Balance ISK', formatNumber(profile.wallet.balance));

  return lines.join('\n').trim() + '\n';
}

function addLine(lines: string[], label: string, value: string | null): void {
  if (!value) return;
  lines.push(`- ${label}: ${value}`);
}

function formatNumber(value: number | null): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Number.isFinite(value) ? value.toLocaleString('en-US') : String(value);
}

function formatNameWithId(name: string | null, id: number | null): string | null {
  if (!name && !id) return null;
  if (name && id) return `${name} (${id})`;
  if (name) return name;
  return String(id);
}

function formatShip(shipName: string | null, typeName: string | null, typeId: number | null): string | null {
  if (!shipName && !typeName && !typeId) return null;
  const parts: string[] = [];
  if (shipName) parts.push(shipName);
  if (typeName) parts.push(typeName);
  if (typeId) parts.push(String(typeId));
  return parts.join(' / ');
}
