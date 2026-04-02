/**
 * analyze_local — parse an EVE Online local chat member list, resolve pilots
 * via ESI, enrich with EVE-KILL kill stats, and return grouped intel.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { getEntityShortStats, getEntityTop } from '../eve-kill/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PILOTS = 150;
const STATS_CONCURRENCY = 10;
const TOP_SHIPS_KILL_THRESHOLD = 5;
const TOP_SHIPS_MAX_PILOTS = 20;
const MAX_NAME_LENGTH = 37;

// ---------------------------------------------------------------------------
// ESI types
// ---------------------------------------------------------------------------

interface EsiIdsResponse {
  characters?: Array<{ id: number; name: string }>;
  corporations?: Array<{ id: number; name: string }>;
  alliances?: Array<{ id: number; name: string }>;
}

interface EsiAffiliation {
  character_id: number;
  corporation_id: number;
  alliance_id?: number;
  faction_id?: number;
}

interface EsiNameEntry {
  id: number;
  name: string;
  category: string;
}

// ---------------------------------------------------------------------------
// Internal pilot record
// ---------------------------------------------------------------------------

interface PilotRecord {
  name: string;
  characterId: number;
  corporationId: number;
  allianceId: number | null;
  kills: number;
  losses: number;
  soloKills: number;
  iskDestroyed: number;
  iskLost: number;
  topShips: string[];
  threat: 'high' | 'medium' | 'low' | 'unknown';
  hasStats: boolean;
}

// ---------------------------------------------------------------------------
// ESI POST helper
// ---------------------------------------------------------------------------

async function esiPost<T>(
  path: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const base = config.esi.baseUrl.endsWith('/')
    ? config.esi.baseUrl
    : config.esi.baseUrl + '/';
  const url = new URL(path.replace(/^\/+/, ''), base);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': config.esi.userAgent,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `ESI HTTP ${res.status}` };
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `ESI request failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Concurrent runner
// ---------------------------------------------------------------------------

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (idx < items.length) {
        const i = idx++;
        await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// ISK formatting
// ---------------------------------------------------------------------------

function formatIsk(value: number): string {
  if (value >= 1e12) return `${(value / 1e12).toFixed(1)}T`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return String(Math.round(value));
}

// ---------------------------------------------------------------------------
// Threat assessment
// ---------------------------------------------------------------------------

function assessThreat(kills: number, soloKills: number, hasStats: boolean): PilotRecord['threat'] {
  if (!hasStats) return 'unknown';
  if (kills >= 10 || soloKills >= 3) return 'high';
  if (kills >= 3) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function executeAnalyzeLocal(
  db: Db,
  args: Record<string, unknown>,
): Promise<unknown> {
  const rawPilots = String(args.pilots ?? '');
  const days = Math.min(Math.max(Number(args.days ?? 7) || 7, 1), 90);

  // 1. Parse names
  const names = [
    ...new Set(
      rawPilots
        .split('\n')
        .map((n) => n.trim())
        .filter((n) => n.length > 0 && n.length <= MAX_NAME_LENGTH),
    ),
  ];

  if (names.length === 0) {
    return { ok: false, error: 'No valid pilot names provided.' };
  }
  if (names.length > MAX_PILOTS) {
    return {
      ok: false,
      error: `Too many pilots (${names.length}). Maximum is ${MAX_PILOTS}.`,
    };
  }

  console.log(`[analyze_local] Parsing ${names.length} names, period=${days}d`);

  // 2. Resolve names → character IDs via ESI
  const idsResult = await esiPost<EsiIdsResponse>('universe/ids/', names);
  if (!idsResult.ok) {
    return { ok: false, error: `Failed to resolve names: ${idsResult.error}` };
  }

  const resolvedChars = idsResult.data.characters ?? [];
  const resolvedNameSet = new Set(resolvedChars.map((c) => c.name.toLowerCase()));
  const unresolved = names.filter((n) => !resolvedNameSet.has(n.toLowerCase()));

  if (resolvedChars.length === 0) {
    return {
      ok: false,
      error: 'No character names could be resolved.',
      unresolved,
    };
  }

  console.log(
    `[analyze_local] Resolved ${resolvedChars.length}/${names.length} characters` +
      (unresolved.length > 0 ? `, unresolved: ${unresolved.length}` : ''),
  );

  // 3. Get affiliations
  const charIds = resolvedChars.map((c) => c.id);
  const affResult = await esiPost<EsiAffiliation[]>('characters/affiliation/', charIds);
  if (!affResult.ok) {
    return { ok: false, error: `Failed to fetch affiliations: ${affResult.error}` };
  }

  const affiliations = affResult.data;
  const affMap = new Map<number, EsiAffiliation>();
  for (const a of affiliations) {
    affMap.set(a.character_id, a);
  }

  // 4. Resolve corp/alliance names
  const entityIds = new Set<number>();
  for (const a of affiliations) {
    entityIds.add(a.corporation_id);
    if (a.alliance_id) entityIds.add(a.alliance_id);
  }

  const nameMap = new Map<number, string>();
  // Characters already have names from step 2
  for (const c of resolvedChars) {
    nameMap.set(c.id, c.name);
  }

  if (entityIds.size > 0) {
    const namesResult = await esiPost<EsiNameEntry[]>(
      'universe/names/',
      [...entityIds],
    );
    if (namesResult.ok) {
      for (const entry of namesResult.data) {
        nameMap.set(entry.id, entry.name);
      }
    } else {
      console.log(`[analyze_local] Warning: failed to resolve entity names: ${namesResult.error}`);
    }
  }

  // 5. Fetch EVE-KILL stats concurrently
  const pilotRecords: PilotRecord[] = resolvedChars.map((c) => {
    const aff = affMap.get(c.id);
    return {
      name: c.name,
      characterId: c.id,
      corporationId: aff?.corporation_id ?? 0,
      allianceId: aff?.alliance_id ?? null,
      kills: 0,
      losses: 0,
      soloKills: 0,
      iskDestroyed: 0,
      iskLost: 0,
      topShips: [],
      threat: 'unknown' as const,
      hasStats: false,
    };
  });

  console.log(`[analyze_local] Fetching kill stats for ${pilotRecords.length} pilots...`);

  await runConcurrent(pilotRecords, STATS_CONCURRENCY, async (pilot) => {
    const statsRes = await getEntityShortStats(db, 'characters', pilot.characterId, days);
    if (statsRes.ok) {
      pilot.kills = statsRes.data.kills ?? 0;
      pilot.losses = statsRes.data.losses ?? 0;
      pilot.soloKills = statsRes.data.solo_kills ?? 0;
      pilot.iskDestroyed = statsRes.data.isk_destroyed ?? 0;
      pilot.iskLost = statsRes.data.isk_lost ?? 0;
      pilot.hasStats = true;
    }
    pilot.threat = assessThreat(pilot.kills, pilot.soloKills, pilot.hasStats);
  });

  // 6. Fetch top ships for active PvPers
  const activePvpers = pilotRecords
    .filter((p) => p.kills >= TOP_SHIPS_KILL_THRESHOLD)
    .sort((a, b) => b.kills - a.kills)
    .slice(0, TOP_SHIPS_MAX_PILOTS);

  if (activePvpers.length > 0) {
    console.log(`[analyze_local] Fetching top ships for ${activePvpers.length} active PvPers...`);

    await runConcurrent(activePvpers, STATS_CONCURRENCY, async (pilot) => {
      const topRes = await getEntityTop(db, 'characters', pilot.characterId, 'ships');
      if (topRes.ok && Array.isArray(topRes.data)) {
        pilot.topShips = topRes.data
          .filter((e) => e.name && e.count && e.count > 0)
          .slice(0, 3)
          .map((e) => e.name!);
      }
    });
  }

  // 7. Group by alliance → corporation → pilots
  interface CompactPilot {
    name: string;
    kills?: number;
    losses?: number;
    solo?: number;
    isk_destroyed?: string;
    ships?: string[];
    threat: string;
  }

  interface CorpGroup {
    name: string;
    count: number;
    pilots: CompactPilot[];
  }

  interface AllianceGroup {
    name: string;
    count: number;
    corps: CorpGroup[];
  }

  function buildCompactPilot(p: PilotRecord): CompactPilot {
    const result: CompactPilot = { name: p.name, threat: p.threat };
    if (p.kills > 0) result.kills = p.kills;
    if (p.losses > 0) result.losses = p.losses;
    if (p.soloKills > 0) result.solo = p.soloKills;
    if (p.iskDestroyed > 0) result.isk_destroyed = formatIsk(p.iskDestroyed);
    if (p.topShips.length > 0) result.ships = p.topShips;
    return result;
  }

  // Group pilots by allianceId → corpId
  const allianceCorpMap = new Map<number | null, Map<number, PilotRecord[]>>();

  for (const pilot of pilotRecords) {
    const allianceKey = pilot.allianceId;
    if (!allianceCorpMap.has(allianceKey)) {
      allianceCorpMap.set(allianceKey, new Map());
    }
    const corpMap = allianceCorpMap.get(allianceKey)!;
    if (!corpMap.has(pilot.corporationId)) {
      corpMap.set(pilot.corporationId, []);
    }
    corpMap.get(pilot.corporationId)!.push(pilot);
  }

  function buildCorpGroups(corpMap: Map<number, PilotRecord[]>): CorpGroup[] {
    const corps: CorpGroup[] = [];
    for (const [corpId, pilots] of corpMap) {
      const sortedPilots = pilots.sort((a, b) => b.kills - a.kills);
      corps.push({
        name: nameMap.get(corpId) ?? `Corp #${corpId}`,
        count: pilots.length,
        pilots: sortedPilots.map(buildCompactPilot),
      });
    }
    return corps.sort((a, b) => b.count - a.count);
  }

  const alliances: AllianceGroup[] = [];
  let noAlliance: CorpGroup[] = [];

  for (const [allianceId, corpMap] of allianceCorpMap) {
    const corps = buildCorpGroups(corpMap);
    const totalPilots = corps.reduce((s, c) => s + c.count, 0);

    if (allianceId === null) {
      noAlliance = corps;
    } else {
      alliances.push({
        name: nameMap.get(allianceId) ?? `Alliance #${allianceId}`,
        count: totalPilots,
        corps,
      });
    }
  }

  alliances.sort((a, b) => b.count - a.count);

  // 8. Summary
  const totalKills = pilotRecords.reduce((s, p) => s + p.kills, 0);
  const totalLosses = pilotRecords.reduce((s, p) => s + p.losses, 0);
  const highThreat = pilotRecords.filter((p) => p.threat === 'high').length;
  const mediumThreat = pilotRecords.filter((p) => p.threat === 'medium').length;
  const activePvpersCount = pilotRecords.filter((p) => p.kills > 0).length;

  const uniqueAlliances = new Set(
    pilotRecords.map((p) => p.allianceId).filter((a) => a !== null),
  );
  const uniqueCorps = new Set(pilotRecords.map((p) => p.corporationId));

  console.log(
    `[analyze_local] Done: ${pilotRecords.length} pilots, ${uniqueAlliances.size} alliances, ` +
      `${uniqueCorps.size} corps, ${highThreat} high-threat`,
  );

  const result: Record<string, unknown> = {
    ok: true,
    scan: {
      total_names: names.length,
      resolved: resolvedChars.length,
      ...(unresolved.length > 0 ? { unresolved } : {}),
      period_days: days,
    },
    alliances,
    ...(noAlliance.length > 0 ? { no_alliance: noAlliance } : {}),
    summary: {
      total: resolvedChars.length,
      alliances: uniqueAlliances.size,
      corporations: uniqueCorps.size,
      high_threat: highThreat,
      medium_threat: mediumThreat,
      active_pvpers: activePvpersCount,
      total_kills: totalKills,
      total_losses: totalLosses,
    },
  };

  return result;
}
