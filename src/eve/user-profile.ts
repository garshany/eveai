import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from './esi-client.js';
import { getEveCapabilities } from './capabilities.js';
import { getLinkedCharacter } from './sso.js';
import type { UserContext } from '../auth/user-resolver.js';
import {
  resolveUserProfilePath,
  withUserProfileAuthorizationLock,
  writeUserProfileAtomic,
} from './user-profile-storage.js';

type JsonResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function readUserProfile(db: Db, ctx: UserContext): Promise<string | null> {
  const characterId = getLinkedCharacter(db, ctx)?.characterId ?? null;
  if (!characterId) return null;
  const path = resolveUserProfilePath(ctx, characterId);
  try {
    const content = (await readFile(path, 'utf-8')).trim();
    if (content.length > 0) return content;
  } catch {
    // file doesn't exist
  }
  return null;
}

export async function refreshUserProfile(db: Db, ctx: UserContext): Promise<JsonResult<{ path: string }>> {
  const capabilities = await getEveCapabilities(db, 'user_profile', ctx);
  if (!capabilities.authenticated || !capabilities.characterId || !capabilities.characterName) {
    return { ok: false, error: 'No authenticated character available.' };
  }

  const characterId = capabilities.characterId;
  const characterName = capabilities.characterName;
  const grantedScopes = normalizeScopes(capabilities.grantedScopes);

  const baseInfo = await runEsiJson<Record<string, unknown>>(db, ctx, 'get_characters_character_id', {
    character_id: characterId,
  });

  const online = capabilities.allowedNamespaces.includes('esi_characters_online')
    ? await runEsiJson<Record<string, unknown>>(db, ctx, 'get_characters_character_id_online', {
      character_id: characterId,
    })
    : null;

  const location = capabilities.allowedNamespaces.includes('esi_characters_location')
    ? await runEsiJson<Record<string, unknown>>(db, ctx, 'get_characters_character_id_location', {
      character_id: characterId,
    })
    : null;

  const ship = capabilities.allowedNamespaces.includes('esi_characters_ship')
    ? await runEsiJson<Record<string, unknown>>(db, ctx, 'get_characters_character_id_ship', {
      character_id: characterId,
    })
    : null;

  const skills = capabilities.allowedNamespaces.includes('esi_characters_skills')
    ? await runEsiJson<Record<string, unknown>>(db, ctx, 'get_characters_character_id_skills', {
      character_id: characterId,
    })
    : null;

  const wallet = capabilities.allowedNamespaces.includes('esi_characters_wallet')
    ? await runEsiJson<number>(db, ctx, 'get_characters_character_id_wallet', {
      character_id: characterId,
    })
    : null;

  const attributes = capabilities.allowedNamespaces.includes('esi_characters_skills')
    ? await runEsiJson<Record<string, unknown>>(db, ctx, 'get_characters_character_id_attributes', {
      character_id: characterId,
    })
    : null;

  const skillQueue = capabilities.allowedNamespaces.includes('esi_characters_skillqueue')
    ? await runEsiJson<Array<Record<string, unknown>>>(db, ctx, 'get_characters_character_id_skillqueue', {
      character_id: characterId,
    })
    : null;

  const implants = capabilities.allowedNamespaces.includes('esi_clones_implants')
    ? await runEsiJson<number[]>(db, ctx, 'get_characters_character_id_implants', {
      character_id: characterId,
    })
    : null;

  const clones = capabilities.allowedNamespaces.includes('esi_clones_clones')
    ? await runEsiJson<Record<string, unknown>>(db, ctx, 'get_characters_character_id_clones', {
      character_id: characterId,
    })
    : null;

  const fittings = capabilities.allowedNamespaces.includes('esi_fittings')
    ? await runEsiJson<Array<Record<string, unknown>>>(db, ctx, 'get_characters_character_id_fittings', {
      character_id: characterId,
    })
    : null;

  const corporationId = extractNumber(baseInfo, 'corporation_id');
  const allianceId = extractNumber(baseInfo, 'alliance_id');
  const factionId = extractNumber(baseInfo, 'faction_id');

  const corporation = corporationId
    ? await runEsiJson<Record<string, unknown>>(db, ctx, 'get_corporations_corporation_id', {
      corporation_id: corporationId,
    })
    : null;

  const alliance = allianceId
    ? await runEsiJson<Record<string, unknown>>(db, ctx, 'get_alliances_alliance_id', {
      alliance_id: allianceId,
    })
    : null;

  const factionName = factionId
    ? await resolveFactionName(db, ctx, factionId)
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
      trained: extractTrainedSkills(db, skills),
    },
    attributes: {
      intelligence: extractNumber(attributes, 'intelligence'),
      memory: extractNumber(attributes, 'memory'),
      perception: extractNumber(attributes, 'perception'),
      willpower: extractNumber(attributes, 'willpower'),
      charisma: extractNumber(attributes, 'charisma'),
      bonusRemaps: extractNumber(attributes, 'bonus_remaps'),
      lastRemapDate: extractString(attributes, 'last_remap_date'),
    },
    skillQueue: extractSkillQueue(db, skillQueue),
    implants: extractImplants(db, implants),
    clones: extractClones(db, clones),
    fittings: extractFittings(db, fittings),
    wallet: {
      balance: wallet && wallet.ok ? wallet.data : null,
    },
  });

  return await withUserProfileAuthorizationLock(characterId, async () => {
    const current = getLinkedCharacter(db, ctx);
    if (
      !current
      || current.characterId !== characterId
      || normalizeScopes(current.scopes) !== grantedScopes
    ) {
      return { ok: false, error: 'EVE authorization changed while the profile was refreshing.' };
    }

    const path = resolveUserProfilePath(ctx, characterId);
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    await writeUserProfileAtomic(path, markdown);
    return { ok: true, data: { path } };
  });
}

function normalizeScopes(scopes: string[]): string {
  return JSON.stringify([...new Set(scopes)].sort());
}

async function runEsiJson<T>(
  db: Db,
  ctx: UserContext,
  operationName: string,
  args: Record<string, unknown>,
): Promise<JsonResult<T>> {
  const result = await callEsiOperation<T>(db, operationName, args, ctx);

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

function extractTrainedSkills(
  db: Db,
  skills: JsonResult<Record<string, unknown>> | null,
): Array<{ name: string; level: number }> {
  if (!skills || !skills.ok) return [];
  const raw = skills.data['skills'];
  if (!Array.isArray(raw)) return [];
  const result: Array<{ name: string; level: number }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const skillId = Number(rec['skill_id']);
    const level = Number(rec['active_skill_level'] ?? rec['trained_skill_level']);
    if (!Number.isFinite(skillId) || !Number.isFinite(level) || level <= 0) continue;
    const name = lookupSdeName(db, 'sde_types', 'type_id', skillId) ?? `skill_id:${skillId}`;
    result.push({ name, level });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

function extractSkillQueue(
  db: Db,
  queue: JsonResult<Array<Record<string, unknown>>> | null,
): Array<{ name: string; finishedLevel: number; finishDate: string | null }> {
  if (!queue || !queue.ok || !Array.isArray(queue.data)) return [];
  return queue.data
    .filter((e) => e && typeof e === 'object')
    .sort((a, b) => Number(a['queue_position'] ?? 0) - Number(b['queue_position'] ?? 0))
    .slice(0, 15)
    .map((e) => {
      const skillId = Number(e['skill_id']);
      const name = lookupSdeName(db, 'sde_types', 'type_id', skillId) ?? `skill_id:${skillId}`;
      return {
        name,
        finishedLevel: Number(e['finished_level'] ?? 0),
        finishDate: typeof e['finish_date'] === 'string' ? e['finish_date'] : null,
      };
    });
}

function extractImplants(
  db: Db,
  implants: JsonResult<number[]> | null,
): Array<{ name: string; typeId: number }> {
  if (!implants || !implants.ok || !Array.isArray(implants.data)) return [];
  return implants.data
    .filter((id) => typeof id === 'number' && Number.isFinite(id))
    .map((typeId) => ({
      name: lookupSdeName(db, 'sde_types', 'type_id', typeId) ?? `type_id:${typeId}`,
      typeId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractClones(
  db: Db,
  clones: JsonResult<Record<string, unknown>> | null,
): Array<{ location: string; implants: string[] }> {
  if (!clones || !clones.ok) return [];
  const jumpClones = clones.data['jump_clones'];
  if (!Array.isArray(jumpClones)) return [];
  return jumpClones
    .filter((c) => c && typeof c === 'object')
    .slice(0, 10)
    .map((c) => {
      const rec = c as Record<string, unknown>;
      const locId = Number(rec['location_id'] ?? 0);
      const locType = String(rec['location_type'] ?? '');
      const cloneName = typeof rec['name'] === 'string' && rec['name'] ? rec['name'] : null;
      const location = cloneName ?? (locType === 'station'
        ? (lookupSdeName(db, 'sde_stations', 'station_id', locId) ?? `station:${locId}`)
        : `structure:${locId}`);
      const implantIds = Array.isArray(rec['implants']) ? rec['implants'] as number[] : [];
      const implantNames = implantIds
        .filter((id) => typeof id === 'number')
        .map((id) => lookupSdeName(db, 'sde_types', 'type_id', id) ?? `type_id:${id}`);
      return { location, implants: implantNames };
    });
}

function extractFittings(
  db: Db,
  fittings: JsonResult<Array<Record<string, unknown>>> | null,
): Array<{ name: string; shipType: string }> {
  if (!fittings || !fittings.ok || !Array.isArray(fittings.data)) return [];
  return fittings.data
    .filter((f) => f && typeof f === 'object')
    .slice(0, 30)
    .map((f) => {
      const name = typeof f['name'] === 'string' ? f['name'] : '?';
      const shipTypeId = Number(f['ship_type_id'] ?? 0);
      const shipType = lookupSdeName(db, 'sde_types', 'type_id', shipTypeId) ?? `type_id:${shipTypeId}`;
      return { name, shipType };
    })
    .sort((a, b) => a.shipType.localeCompare(b.shipType));
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

async function resolveFactionName(db: Db, ctx: UserContext, factionId: number): Promise<string | null> {
  const result = await runEsiJson<Record<string, unknown>[]>(db, ctx, 'get_universe_factions', {});
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
    trained: Array<{ name: string; level: number }>;
  };
  attributes: {
    intelligence: number | null;
    memory: number | null;
    perception: number | null;
    willpower: number | null;
    charisma: number | null;
    bonusRemaps: number | null;
    lastRemapDate: string | null;
  };
  skillQueue: Array<{ name: string; finishedLevel: number; finishDate: string | null }>;
  implants: Array<{ name: string; typeId: number }>;
  clones: Array<{ location: string; implants: string[] }>;
  fittings: Array<{ name: string; shipType: string }>;
  wallet: {
    balance: number | null;
  };
};

export function buildUserMarkdown(profile: UserProfileData): string {
  const lines: string[] = [];
  lines.push('# User Profile');
  lines.push(`Updated: ${profile.updatedAt}`);
  lines.push('');
  lines.push('## Character');
  lines.push(`- Name: ${sanitizeProfileValue(profile.character.name)}`);
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
  if (profile.skills.trained.length > 0) {
    lines.push('');
    lines.push('### Trained Skills');
    for (const s of profile.skills.trained) {
      lines.push(`- ${sanitizeProfileValue(s.name)}: ${s.level}`);
    }
  }

  if (profile.attributes.intelligence) {
    lines.push('');
    lines.push('## Attributes');
    addLine(lines, 'Intelligence', String(profile.attributes.intelligence));
    addLine(lines, 'Memory', String(profile.attributes.memory));
    addLine(lines, 'Perception', String(profile.attributes.perception));
    addLine(lines, 'Willpower', String(profile.attributes.willpower));
    addLine(lines, 'Charisma', String(profile.attributes.charisma));
    addLine(lines, 'Bonus remaps', profile.attributes.bonusRemaps ? String(profile.attributes.bonusRemaps) : null);
    addLine(lines, 'Last remap', profile.attributes.lastRemapDate);
  }

  if (profile.skillQueue.length > 0) {
    lines.push('');
    lines.push('## Skill Queue');
    for (const s of profile.skillQueue) {
      const eta = s.finishDate ? ` (ETA: ${s.finishDate})` : '';
      lines.push(`- ${sanitizeProfileValue(s.name)} → ${s.finishedLevel}${eta}`);
    }
  }

  if (profile.implants.length > 0) {
    lines.push('');
    lines.push('## Active Implants');
    for (const imp of profile.implants) {
      lines.push(`- ${sanitizeProfileValue(imp.name)}`);
    }
  }

  if (profile.clones.length > 0) {
    lines.push('');
    lines.push('## Jump Clones');
    for (const clone of profile.clones) {
      const implantNames = clone.implants
        .map((implant) => sanitizeProfileValue(implant))
        .filter((implant): implant is string => Boolean(implant));
      const impList = implantNames.length > 0 ? ` [${implantNames.join(', ')}]` : ' [empty]';
      lines.push(`- ${sanitizeProfileValue(clone.location) ?? 'unknown'}${impList}`);
    }
  }

  if (profile.fittings.length > 0) {
    lines.push('');
    lines.push('## Saved Fittings');
    for (const fit of profile.fittings) {
      const shipType = sanitizeProfileValue(fit.shipType) ?? 'unknown';
      const fitName = sanitizeProfileValue(fit.name) ?? '?';
      lines.push(`- ${shipType}: ${fitName}`);
    }
  }

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
  const safeName = sanitizeProfileValue(name);
  if (safeName && id) return `${safeName} (${id})`;
  if (safeName) return safeName;
  return String(id);
}

function formatShip(shipName: string | null, typeName: string | null, typeId: number | null): string | null {
  if (!shipName && !typeName && !typeId) return null;
  const parts: string[] = [];
  const safeShipName = sanitizeProfileValue(shipName);
  const safeTypeName = sanitizeProfileValue(typeName);
  if (safeShipName) parts.push(safeShipName);
  if (safeTypeName) parts.push(safeTypeName);
  if (typeId) parts.push(String(typeId));
  return parts.join(' / ');
}

function sanitizeProfileValue(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/[`<>]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, 120);
}
