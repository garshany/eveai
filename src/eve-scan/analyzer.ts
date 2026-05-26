/**
 * analyze_scan — unified EVE Online scan parser.
 * Handles D-Scan, Local chat, and Fleet composition pastes.
 * Auto-detects scan type from paste format.
 *
 * Ship roles and groups derived from SDE dynamically via pattern matching
 * on group names — no hardcoded group lists.
 */

import type { Db } from '../db/sqlite.js';
import { executeAnalyzeLocal } from '../eve-local/analyzer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LINES = 1000;
const ON_GRID_THRESHOLD_KM = 10_000;

// SDE category IDs (stable CCP constants)
const CAT_SHIP = 6;
// Noise categories filtered from output
const CAT_CELESTIAL = 2;
const CAT_ASTEROID = 25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScanType = 'dscan' | 'local' | 'fleet';

interface SdeTypeRow {
  type_id: number;
  name: string;
  group_id: number;
  group_name: string;
  category_id: number;
  category_name: string;
}

interface TypeCount {
  name: string;
  count: number;
  groupName: string;
  categoryId: number;
  categoryName: string;
}

interface GroupOut {
  group: string;
  role: string;
  count: number;
  types: string[];
}

interface CatOut {
  count: number;
  groups: GroupOut[];
}

// ---------------------------------------------------------------------------
// Ship role classification — pattern-based on SDE group names
// ---------------------------------------------------------------------------

// Role patterns: tested against lowercased group name.
// Order matters — first match wins.
const ROLE_PATTERNS: Array<[RegExp, string]> = [
  [/logistic/i, 'logistics'],
  [/force auxiliary/i, 'logistics'],
  [/electronic attack/i, 'ewar'],
  [/recon ship/i, 'ewar'],
  [/interceptor/i, 'tackle'],
  [/interdictor/i, 'tackle'],   // matches Interdictor and Heavy Interdiction Cruiser
  [/covert ops/i, 'scout'],
  [/stealth bomber/i, 'scout'],
  [/titan/i, 'capital'],
  [/supercarrier/i, 'capital'],
  [/dreadnought/i, 'capital'],
  [/\bcarrier\b/i, 'capital'],  // word boundary to avoid "Blockade Runner" false match
  [/freighter/i, 'industrial'],
  [/transport/i, 'industrial'],
  [/blockade runner/i, 'industrial'],
  [/industrial/i, 'industrial'],
  [/mining barge/i, 'industrial'],
  [/exhumer/i, 'industrial'],
  [/expedition frigate/i, 'industrial'],
  [/capsule/i, 'non_combat'],
  [/shuttle/i, 'non_combat'],
  [/rookie/i, 'non_combat'],
];

function classifyRole(groupName: string): string {
  for (const [pattern, role] of ROLE_PATTERNS) {
    if (pattern.test(groupName)) return role;
  }
  return 'dps';
}

// ---------------------------------------------------------------------------
// Group display order — pattern-based size tiers
// ---------------------------------------------------------------------------

const SIZE_TIER_PATTERNS: Array<[RegExp, number]> = [
  [/titan/i, 1],
  [/supercarrier/i, 2],
  [/dreadnought/i, 3],
  [/\bcarrier\b/i, 4],
  [/force auxiliary/i, 5],
  [/battleship|black ops|marauder/i, 10],
  [/battlecruiser|command ship/i, 20],
  [/strategic cruiser/i, 25],
  [/cruiser|heavy assault|recon/i, 30],
  [/logistic.*cruiser/i, 35],
  [/destroyer|interdictor|command destroyer|tactical destroyer/i, 40],
  [/frigate|assault|interceptor|stealth|electronic|covert|logistic.*frigate/i, 50],
];

function groupSortOrder(groupName: string): number {
  for (const [pattern, order] of SIZE_TIER_PATTERNS) {
    if (pattern.test(groupName)) return order;
  }
  return 90;
}

// ---------------------------------------------------------------------------
// "Interesting" detection — pattern-based
// ---------------------------------------------------------------------------

const INTERESTING_GROUP_PATTERNS = [
  /titan/i, /supercarrier/i, /dreadnought/i, /\bcarrier\b/i, /force auxiliary/i,
  /black ops/i, /marauder/i, /command ship/i, /command destroyer/i,
  /strategic cruiser/i, /interdictor/i, /recon/i,
];

const INTERESTING_TYPE_PATTERNS = [
  /^monitor$/i,                       // FC immune ship
  /ansiblex/i,                        // jump bridge
  /pharolux/i,                        // cyno beacon
  /tenebrex/i,                        // cyno jammer
  /cynosural inhibitor/i,             // deployable cyno jam
  /warp disruptor/i,                  // drag bubbles
];

function isInteresting(groupName: string, typeName: string): boolean {
  for (const p of INTERESTING_GROUP_PATTERNS) {
    if (p.test(groupName)) return true;
  }
  for (const p of INTERESTING_TYPE_PATTERNS) {
    if (p.test(typeName)) return true;
  }
  return false;
}

function isCapital(groupName: string): boolean {
  return /titan|supercarrier|dreadnought|force auxiliary/i.test(groupName)
    || (/\bcarrier\b/i.test(groupName) && !/blockade/i.test(groupName));
}

// ---------------------------------------------------------------------------
// Scan type auto-detection
// ---------------------------------------------------------------------------

const DISTANCE_RE = /\d[\d,.]*\s*(?:km|AU|m)\s*$/;

function detectScanType(lines: string[]): ScanType {
  const sample = lines.slice(0, 30);
  let tabs = 0;
  let distances = 0;
  for (const l of sample) {
    if (l.includes('\t')) tabs++;
    if (DISTANCE_RE.test(l)) distances++;
  }
  const n = sample.length || 1;
  if (distances / n > 0.25) return 'dscan';
  if (tabs / n > 0.4) return 'fleet';
  return 'local';
}

// ---------------------------------------------------------------------------
// Distance parsing (for on-grid / off-grid)
// ---------------------------------------------------------------------------

function parseDistanceKm(raw: string): number | null {
  const cleaned = raw.replace(/[*,\s]/g, '').trim();
  const match = /^([\d.]+)(km|AU|m)$/i.exec(cleaned);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (isNaN(value)) return null;
  const unit = match[2].toLowerCase();
  if (unit === 'au') return value * 149_597_870.7;
  if (unit === 'm') return value / 1000;
  return value;
}

// ---------------------------------------------------------------------------
// SDE batch resolution
// ---------------------------------------------------------------------------

function resolveByIds(db: Db, ids: number[]): Map<number, SdeTypeRow> {
  const m = new Map<number, SdeTypeRow>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const ph = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT t.type_id, t.name, t.group_id,
             g.name AS group_name, g.category_id,
             c.name AS category_name
      FROM sde_types t
      JOIN sde_groups g ON g.group_id = t.group_id
      JOIN sde_categories c ON c.category_id = g.category_id
      WHERE t.type_id IN (${ph})
    `).all(...chunk) as SdeTypeRow[];
    for (const r of rows) m.set(r.type_id, r);
  }
  return m;
}

function resolveByNames(db: Db, names: string[]): Map<string, SdeTypeRow> {
  const m = new Map<string, SdeTypeRow>();
  for (let i = 0; i < names.length; i += 200) {
    const chunk = names.slice(i, i + 200);
    const ph = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT t.type_id, t.name, t.group_id,
             g.name AS group_name, g.category_id,
             c.name AS category_name
      FROM sde_types t
      JOIN sde_groups g ON g.group_id = t.group_id
      JOIN sde_categories c ON c.category_id = g.category_id
      WHERE t.name COLLATE NOCASE IN (${ph})
    `).all(...chunk) as SdeTypeRow[];
    for (const r of rows) m.set(r.name.toLowerCase(), r);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Counting & grouping
// ---------------------------------------------------------------------------

function countTypes(
  entries: Array<{ typeId: number | null; typeName: string }>,
  idMap: Map<number, SdeTypeRow>,
  nameMap: Map<string, SdeTypeRow>,
): TypeCount[] {
  const counts = new Map<string, TypeCount>();
  for (const e of entries) {
    const sde = (e.typeId !== null ? idMap.get(e.typeId) : undefined)
      ?? nameMap.get(e.typeName.toLowerCase());
    if (!sde) continue;
    const key = String(sde.type_id);
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, {
        name: sde.name,
        count: 1,
        groupName: sde.group_name,
        categoryId: sde.category_id,
        categoryName: sde.category_name,
      });
    }
  }
  return [...counts.values()];
}

function groupByCat(tcs: TypeCount[]): Record<string, CatOut> {
  const catMap = new Map<string, Map<string, TypeCount[]>>();
  for (const tc of tcs) {
    if (!catMap.has(tc.categoryName)) catMap.set(tc.categoryName, new Map());
    const gm = catMap.get(tc.categoryName)!;
    if (!gm.has(tc.groupName)) gm.set(tc.groupName, []);
    gm.get(tc.groupName)!.push(tc);
  }

  const out: Record<string, CatOut> = {};
  for (const [cat, gm] of catMap) {
    const groups: GroupOut[] = [];
    let total = 0;
    for (const [grp, types] of gm) {
      const n = types.reduce((s, t) => s + t.count, 0);
      total += n;
      const isShipCat = types[0]?.categoryId === CAT_SHIP;
      groups.push({
        group: grp,
        role: isShipCat ? classifyRole(grp) : 'n/a',
        count: n,
        types: types
          .sort((a, b) => b.count - a.count)
          .map((t) => (t.count > 1 ? `${t.name} x${t.count}` : t.name)),
      });
    }
    groups.sort((a, b) => groupSortOrder(a.group) - groupSortOrder(b.group));
    out[cat] = { count: total, groups };
  }
  return out;
}

function buildFleetProfile(tcs: TypeCount[]): Record<string, unknown> {
  let combat = 0;
  let logi = 0;
  let ewar = 0;
  let tackle = 0;
  let caps = 0;
  let indus = 0;
  let scouts = 0;

  for (const tc of tcs) {
    if (tc.categoryId !== CAT_SHIP) continue;
    const role = classifyRole(tc.groupName);
    switch (role) {
      case 'logistics': logi += tc.count; break;
      case 'ewar': ewar += tc.count; break;
      case 'tackle': tackle += tc.count; break;
      case 'capital': caps += tc.count; break;
      case 'industrial': indus += tc.count; break;
      case 'scout': scouts += tc.count; break;
      case 'non_combat': break;
      default: combat += tc.count;
    }
  }

  const totalCombat = combat + logi + ewar + tackle + caps;
  let estimatedType = 'solo';
  if (caps > 0) estimatedType = 'capital_fleet';
  else if (totalCombat >= 30) estimatedType = 'large_fleet';
  else if (totalCombat >= 10) estimatedType = 'medium_gang';
  else if (totalCombat >= 3) estimatedType = 'small_gang';

  return {
    combat_ships: combat,
    logistics: logi,
    ewar,
    tackle,
    capitals: caps,
    industrials: indus,
    scouts,
    estimated_type: estimatedType,
    logi_ratio: totalCombat > 0 ? `${Math.round((logi / totalCombat) * 100)}%` : null,
  };
}

// ---------------------------------------------------------------------------
// Extract "interesting" items + capitals (pattern-based)
// ---------------------------------------------------------------------------

function extractInteresting(tcs: TypeCount[]): string[] {
  const items: string[] = [];
  for (const tc of tcs) {
    if (isInteresting(tc.groupName, tc.name)) {
      items.push(tc.count > 1 ? `${tc.name} x${tc.count}` : tc.name);
    }
  }
  return items;
}

function extractCaps(tcs: TypeCount[]): string[] | null {
  const caps: string[] = [];
  for (const tc of tcs) {
    if (tc.categoryId === CAT_SHIP && isCapital(tc.groupName)) {
      caps.push(tc.count > 1 ? `${tc.name} x${tc.count}` : tc.name);
    }
  }
  return caps.length > 0 ? caps : null;
}

// ---------------------------------------------------------------------------
// D-Scan analysis
// ---------------------------------------------------------------------------

interface DscanEntry {
  typeId: number | null;
  typeName: string;
  distanceKm: number | null;
}

function parseDscanLines(lines: string[]): DscanEntry[] {
  const entries: DscanEntry[] = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const first = parts[0].trim();
    const num = parseInt(first, 10);
    if (!isNaN(num) && parts.length >= 3) {
      const distRaw = parts[3]?.trim() ?? '';
      entries.push({ typeId: num, typeName: parts[1].trim(), distanceKm: parseDistanceKm(distRaw) });
    } else {
      const distRaw = parts[2]?.trim() ?? parts[1]?.trim() ?? '';
      entries.push({ typeId: null, typeName: first, distanceKm: parseDistanceKm(distRaw) });
    }
  }
  return entries;
}

function analyzeDscan(db: Db, lines: string[]): unknown {
  const entries = parseDscanLines(lines);
  if (entries.length === 0) {
    return { ok: false, error: 'Could not parse D-Scan. Expected tab-separated lines.' };
  }

  console.log(`[analyze_scan] D-Scan: ${entries.length} entries`);

  const ids = [...new Set(entries.filter((e) => e.typeId !== null).map((e) => e.typeId!))];
  const names = [...new Set(entries.filter((e) => e.typeId === null).map((e) => e.typeName))];
  const idMap = resolveByIds(db, ids);
  const nameMap = resolveByNames(db, names);

  const allEntries = entries.map((e) => ({ typeId: e.typeId, typeName: e.typeName }));
  const tcs = countTypes(allEntries, idMap, nameMap);
  const cats = groupByCat(tcs);
  const profile = buildFleetProfile(tcs);
  const interesting = extractInteresting(tcs);
  const caps = extractCaps(tcs);

  // On-grid / off-grid
  let onGrid = 0;
  let offGrid = 0;
  for (const e of entries) {
    if (e.distanceKm !== null) {
      if (e.distanceKm <= ON_GRID_THRESHOLD_KM) onGrid++;
      else offGrid++;
    }
  }
  const hasGridInfo = onGrid > 0 || offGrid > 0;

  // Strip noise categories by numeric ID
  const celestials = cats['Celestial']?.count ?? 0;
  const asteroids = cats['Asteroid']?.count ?? 0;
  const filtered: Record<string, CatOut> = {};
  for (const [catName, catData] of Object.entries(cats)) {
    const firstCatId = tcs.find((tc) => tc.categoryName === catName)?.categoryId;
    if (firstCatId === CAT_CELESTIAL || firstCatId === CAT_ASTEROID) continue;
    filtered[catName] = catData;
  }

  return {
    ok: true,
    scan_type: 'dscan',
    total_objects: entries.length,
    resolved: tcs.reduce((s, t) => s + t.count, 0),
    categories: filtered,
    fleet_profile: profile,
    ...(interesting.length > 0 ? { interesting } : {}),
    ...(caps ? { capitals: caps } : {}),
    ...(hasGridInfo ? { grid: { on_grid: onGrid, off_grid: offGrid } } : {}),
    ...(celestials > 0 ? { celestials_filtered: celestials } : {}),
    ...(asteroids > 0 ? { asteroids_filtered: asteroids } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fleet composition analysis
// ---------------------------------------------------------------------------

function analyzeFleet(db: Db, lines: string[]): unknown {
  const raw: string[][] = [];
  for (const line of lines) {
    const parts = line.split('\t').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) raw.push(parts);
  }
  if (raw.length === 0) {
    return { ok: false, error: 'Could not parse fleet composition.' };
  }

  console.log(`[analyze_scan] Fleet: ${raw.length} entries`);

  // Detect ship column by resolving sample against SDE
  const maxCols = Math.min(raw[0].length, 5);
  const sample = raw.slice(0, 15);
  let bestCol = 1;
  let bestHits = 0;

  for (let col = 0; col < maxCols; col++) {
    const colNames = [...new Set(sample.map((r) => r[col]).filter(Boolean))];
    const resolved = resolveByNames(db, colNames);
    const hits = sample.filter((r) => r[col] && resolved.has(r[col].toLowerCase())).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestCol = col;
    }
  }

  const pilotCol = bestCol === 0 ? 1 : 0;

  const allShipNames = [...new Set(raw.map((r) => r[bestCol]).filter(Boolean))];
  const nameMap = resolveByNames(db, allShipNames);

  const entries = raw.map((r) => ({ typeId: null as number | null, typeName: r[bestCol] ?? '' }));
  const tcs = countTypes(entries, new Map(), nameMap);
  const cats = groupByCat(tcs);
  const profile = buildFleetProfile(tcs);
  const interesting = extractInteresting(tcs);
  const caps = extractCaps(tcs);

  const pilots = raw.slice(0, 50).map((r) => ({ name: r[pilotCol] ?? '', ship: r[bestCol] ?? '' }));

  return {
    ok: true,
    scan_type: 'fleet',
    total_pilots: raw.length,
    resolved_ships: tcs.reduce((s, t) => s + t.count, 0),
    categories: cats,
    fleet_profile: profile,
    ...(interesting.length > 0 ? { interesting } : {}),
    ...(caps ? { capitals: caps } : {}),
    pilots,
    ...(raw.length > 50 ? { pilots_truncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function executeAnalyzeScan(
  db: Db,
  args: Record<string, unknown>,
): Promise<unknown> {
  const paste = String(args.paste ?? '');
  const forced = typeof args.scan_type === 'string'
    ? (args.scan_type as ScanType)
    : null;

  const lines = paste.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { ok: false, error: 'Empty paste.' };
  }
  if (lines.length > MAX_LINES) {
    return { ok: false, error: `Too many lines (${lines.length}). Max ${MAX_LINES}.` };
  }

  const scanType = forced ?? detectScanType(lines);
  console.log(`[analyze_scan] type=${scanType}, lines=${lines.length}`);

  if (scanType === 'local') {
    return executeAnalyzeLocal(db, { pilots: paste, days: args.days ?? 7 });
  }
  if (scanType === 'dscan') {
    return analyzeDscan(db, lines);
  }
  return analyzeFleet(db, lines);
}
