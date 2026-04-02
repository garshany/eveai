/**
 * analyze_scan — unified EVE Online scan parser.
 * Handles D-Scan, Local chat, and Fleet composition pastes.
 * Auto-detects scan type from paste format.
 *
 * Inspired by adashboard.info multi-view approach:
 * ships by class, caps extraction, "interesting" highlights,
 * on/off grid separation, combat-only view, fleet profiling.
 */

import type { Db } from '../db/sqlite.js';
import { executeAnalyzeLocal } from '../eve-local/analyzer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LINES = 1000;
const ON_GRID_THRESHOLD_KM = 10_000;

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
// Ship role classification (group name → role)
// ---------------------------------------------------------------------------

const ROLE_MAP: Record<string, string> = {
  'Logistics Cruiser': 'logistics',
  'Logistics Frigate': 'logistics',
  'Force Auxiliary': 'logistics',
  'Electronic Attack Ship': 'ewar',
  'Force Recon Ship': 'ewar',
  'Combat Recon Ship': 'ewar',
  'Interceptor': 'tackle',
  'Interdictor': 'tackle',
  'Heavy Interdiction Cruiser': 'tackle',
  'Covert Ops': 'scout',
  'Stealth Bomber': 'scout',
  'Carrier': 'capital',
  'Dreadnought': 'capital',
  'Supercarrier': 'capital',
  'Titan': 'capital',
  'Industrial Ship': 'industrial',
  'Transport Ship': 'industrial',
  'Blockade Runner': 'industrial',
  'Deep Space Transport': 'industrial',
  'Freighter': 'industrial',
  'Jump Freighter': 'industrial',
  'Mining Barge': 'industrial',
  'Exhumer': 'industrial',
  'Industrial Command Ship': 'industrial',
  'Capital Industrial Ship': 'industrial',
  'Expedition Frigate': 'industrial',
  'Capsule': 'non_combat',
  'Shuttle': 'non_combat',
  'Rookie ship': 'non_combat',
};

// Display order: lower = bigger threat, shown first
const GROUP_ORDER: Record<string, number> = {
  Titan: 1, Supercarrier: 2, Dreadnought: 3, Carrier: 4, 'Force Auxiliary': 5,
  Battleship: 10, 'Black Ops': 11, Marauder: 12,
  Battlecruiser: 20, 'Command Ship': 21,
  'Strategic Cruiser': 25,
  'Heavy Assault Cruiser': 30, Cruiser: 31,
  'Heavy Interdiction Cruiser': 32, 'Combat Recon Ship': 33, 'Force Recon Ship': 34,
  'Logistics Cruiser': 35,
  'Tactical Destroyer': 40, Destroyer: 41, Interdictor: 42, 'Command Destroyer': 43,
  'Assault Frigate': 50, Frigate: 51, Interceptor: 52, 'Stealth Bomber': 53,
  'Electronic Attack Ship': 54, 'Covert Ops': 55, 'Logistics Frigate': 56,
};

// "Interesting" groups — tactically significant items highlighted by FC tools
// (adashboard.info "Interesting" section concept)
const INTERESTING_GROUPS = new Set([
  'Titan', 'Supercarrier', 'Dreadnought', 'Carrier', 'Force Auxiliary',
  'Black Ops', 'Marauder', 'Command Ship', 'Command Destroyer',
  'Strategic Cruiser', 'Heavy Interdiction Cruiser',
  'Combat Recon Ship', 'Force Recon Ship',
]);

// Interesting type names (specific ships/items regardless of group)
const INTERESTING_TYPES = new Set([
  'Monitor',                          // FC immune ship
  'Ansiblex Jump Gate',               // jump bridge
  'Pharolux Cyno Beacon',             // cyno beacon
  'Tenebrex Cyno Jammer',             // cyno jammer
  'Mobile Cynosural Inhibitor',       // deployable cyno jam
  'Mobile Large Warp Disruptor I',    // drag bubble
  'Mobile Large Warp Disruptor II',
  'Mobile Medium Warp Disruptor I',
  'Mobile Medium Warp Disruptor II',
  'Mobile Small Warp Disruptor I',
  'Mobile Small Warp Disruptor II',
]);

// Capital groups for caps extraction
const CAPITAL_GROUPS = new Set([
  'Titan', 'Supercarrier', 'Dreadnought', 'Carrier', 'Force Auxiliary',
]);

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
  return value; // km
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
      groups.push({
        group: grp,
        role: cat === 'Ship' ? (ROLE_MAP[grp] ?? 'dps') : 'n/a',
        count: n,
        types: types
          .sort((a, b) => b.count - a.count)
          .map((t) => (t.count > 1 ? `${t.name} x${t.count}` : t.name)),
      });
    }
    groups.sort((a, b) => (GROUP_ORDER[a.group] ?? 90) - (GROUP_ORDER[b.group] ?? 90));
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
    if (tc.categoryName !== 'Ship') continue;
    const role = ROLE_MAP[tc.groupName] ?? 'dps';
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
// Extract "interesting" items (adashboard concept)
// ---------------------------------------------------------------------------

function extractInteresting(tcs: TypeCount[]): string[] {
  const items: string[] = [];
  for (const tc of tcs) {
    if (INTERESTING_GROUPS.has(tc.groupName) || INTERESTING_TYPES.has(tc.name)) {
      items.push(tc.count > 1 ? `${tc.name} x${tc.count}` : tc.name);
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Extract capitals summary
// ---------------------------------------------------------------------------

function extractCaps(tcs: TypeCount[]): string[] | null {
  const caps: string[] = [];
  for (const tc of tcs) {
    if (CAPITAL_GROUPS.has(tc.groupName)) {
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
      // Standard format: typeID \t TypeName \t ItemName \t Distance
      const distRaw = parts[3]?.trim() ?? '';
      entries.push({
        typeId: num,
        typeName: parts[1].trim(),
        distanceKm: parseDistanceKm(distRaw),
      });
    } else {
      // Fallback: TypeName \t ItemName \t Distance
      const distRaw = parts[2]?.trim() ?? parts[1]?.trim() ?? '';
      entries.push({
        typeId: null,
        typeName: first,
        distanceKm: parseDistanceKm(distRaw),
      });
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

  // Resolve via SDE
  const ids = [...new Set(entries.filter((e) => e.typeId !== null).map((e) => e.typeId!))];
  const names = [...new Set(entries.filter((e) => e.typeId === null).map((e) => e.typeName))];
  const idMap = resolveByIds(db, ids);
  const nameMap = resolveByNames(db, names);

  // Count all
  const allEntries = entries.map((e) => ({ typeId: e.typeId, typeName: e.typeName }));
  const tcs = countTypes(allEntries, idMap, nameMap);
  const cats = groupByCat(tcs);
  const profile = buildFleetProfile(tcs);
  const interesting = extractInteresting(tcs);
  const caps = extractCaps(tcs);

  // On-grid / off-grid counts
  let onGrid = 0;
  let offGrid = 0;
  for (const e of entries) {
    if (e.distanceKm !== null) {
      if (e.distanceKm <= ON_GRID_THRESHOLD_KM) onGrid++;
      else offGrid++;
    }
  }
  const hasGridInfo = onGrid > 0 || offGrid > 0;

  // Strip noise categories to save context tokens
  const celestials = cats['Celestial']?.count ?? 0;
  delete cats['Celestial'];
  const asteroids = cats['Asteroid']?.count ?? 0;
  delete cats['Asteroid'];

  return {
    ok: true,
    scan_type: 'dscan',
    total_objects: entries.length,
    resolved: tcs.reduce((s, t) => s + t.count, 0),
    categories: cats,
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

  // EVE fleet window format has 5-7 columns:
  // Pilot \t System(+Docked) \t ShipClass \t ShipType \t Position \t ...
  // But pastes vary. Detect ship column by resolving sample against SDE.
  const maxCols = Math.min(raw[0].length, 5);
  const sample = raw.slice(0, 15);

  let bestCol = 1;
  let bestHits = 0;
  const colMaps: Map<string, SdeTypeRow>[] = [];

  for (let col = 0; col < maxCols; col++) {
    const colNames = [...new Set(sample.map((r) => r[col]).filter(Boolean))];
    const resolved = resolveByNames(db, colNames);
    colMaps[col] = resolved;
    const hits = sample.filter((r) => r[col] && resolved.has(r[col].toLowerCase())).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestCol = col;
    }
  }

  // Pilot column = first column that isn't the ship column (prefer col 0)
  const pilotCol = bestCol === 0 ? 1 : 0;

  // Resolve all ship names from the detected column
  const allShipNames = [...new Set(raw.map((r) => r[bestCol]).filter(Boolean))];
  const nameMap = resolveByNames(db, allShipNames);

  const entries = raw.map((r) => ({ typeId: null as number | null, typeName: r[bestCol] ?? '' }));
  const tcs = countTypes(entries, new Map(), nameMap);
  const cats = groupByCat(tcs);
  const profile = buildFleetProfile(tcs);
  const interesting = extractInteresting(tcs);
  const caps = extractCaps(tcs);

  const pilots = raw.slice(0, 50).map((r) => ({
    name: r[pilotCol] ?? '',
    ship: r[bestCol] ?? '',
  }));

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
