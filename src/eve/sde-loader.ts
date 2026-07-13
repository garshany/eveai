/**
 * SDE Loader -- imports EVE static data from JSON Lines files into SQLite.
 *
 * Usage: npm run sde:load
 *
 * Expects JSONL files in SDE_DATA_DIR (default: ./data/sde/).
 *
 * SDE format (post-September 2025 rework):
 *   - Names are localized objects: {"en": "Tritanium", "ru": "Тританиум", ...}
 *   - We extract the English name as the primary name
 *   - Full JSON is stored in data_json for complete access
 *
 * File naming: CCP uses files like types.jsonl, groups.jsonl, etc.
 * Some files may be nested in subdirectories after zip extraction.
 */

import 'dotenv/config';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initDb } from '../db/sqlite.js';
import { runMigrations } from '../db/migrations.js';

// Deliberately no src/config.js import: setup must work before the operator
// has filled in the rest of .env (bot tokens, OpenAI key, EVE credentials).
const SDE_DATA_DIR = process.env.SDE_DATA_DIR || './data/sde';
const DB_PATH = process.env.DB_PATH || './data/eve-agent.db';

export interface LoaderConfig {
  /** Possible file names to look for (without path) */
  filePatterns: string[];
  table: string;
  idField: string;
  nameField?: string;
  /** Additional columns to extract from JSON into separate DB columns */
  extraCols?: Record<string, string>; // column_name -> json_field
  /** When name is missing, derive it from sde_types using this ID field */
  nameFromTypeIdField?: string;
}

const LOADERS: LoaderConfig[] = [
  {
    filePatterns: ['types.jsonl', 'invTypes.jsonl'],
    table: 'sde_types',
    idField: 'type_id',
    nameField: 'name',
    extraCols: { group_id: 'group_id' },
  },
  {
    filePatterns: ['groups.jsonl', 'invGroups.jsonl'],
    table: 'sde_groups',
    idField: 'group_id',
    nameField: 'name',
    extraCols: { category_id: 'category_id' },
  },
  {
    filePatterns: ['categories.jsonl', 'invCategories.jsonl'],
    table: 'sde_categories',
    idField: 'category_id',
    nameField: 'name',
  },
  {
    filePatterns: ['marketGroups.jsonl', 'market_groups.jsonl', 'invMarketGroups.jsonl'],
    table: 'sde_market_groups',
    idField: 'market_group_id',
    nameField: 'name',
    extraCols: { parent_group_id: 'parent_group_id' },
  },
  {
    filePatterns: ['metaGroups.jsonl', 'meta_groups.jsonl'],
    table: 'sde_meta_groups',
    idField: 'meta_group_id',
    nameField: 'name',
  },
  {
    filePatterns: ['dogmaAttributes.jsonl', 'dogma_attributes.jsonl'],
    table: 'sde_dogma_attributes',
    idField: 'attribute_id',
    nameField: 'name',
  },
  {
    filePatterns: ['dogmaUnits.jsonl', 'dogma_units.jsonl'],
    table: 'sde_dogma_units',
    idField: 'unit_id',
    nameField: 'name',
  },
  {
    filePatterns: ['dogmaEffects.jsonl', 'dogma_effects.jsonl'],
    table: 'sde_dogma_effects',
    idField: 'effect_id',
    nameField: 'name',
  },
  {
    filePatterns: ['typeDogma.jsonl', 'type_dogma.jsonl'],
    table: 'sde_type_dogma',
    idField: 'type_id',
  },
  {
    filePatterns: ['typeBonus.jsonl', 'type_bonus.jsonl'],
    table: 'sde_type_bonus',
    idField: 'type_id',
  },
  {
    filePatterns: ['typeMaterials.jsonl', 'type_materials.jsonl'],
    table: 'sde_type_materials',
    idField: 'type_id',
    nameFromTypeIdField: 'type_id',
  },
  {
    filePatterns: ['certificates.jsonl'],
    table: 'sde_certificates',
    idField: 'certificate_id',
    nameField: 'name',
  },
  {
    filePatterns: ['masteries.jsonl'],
    table: 'sde_masteries',
    idField: 'type_id',
    nameFromTypeIdField: 'type_id',
  },
  {
    filePatterns: ['factions.jsonl'],
    table: 'sde_factions',
    idField: 'faction_id',
    nameField: 'name',
  },
  {
    filePatterns: ['races.jsonl'],
    table: 'sde_races',
    idField: 'race_id',
    nameField: 'name',
  },
  {
    filePatterns: ['regions.jsonl', 'mapRegions.jsonl'],
    table: 'sde_regions',
    idField: 'region_id',
    nameField: 'name',
  },
  {
    filePatterns: ['constellations.jsonl', 'mapConstellations.jsonl'],
    table: 'sde_constellations',
    idField: 'constellation_id',
    nameField: 'name',
    extraCols: { region_id: 'region_id' },
  },
  {
    filePatterns: ['solarSystems.jsonl', 'systems.jsonl', 'mapSolarSystems.jsonl'],
    table: 'sde_systems',
    idField: 'system_id',
    nameField: 'name',
    extraCols: { constellation_id: 'constellation_id' },
  },
  {
    filePatterns: ['stations.jsonl', 'staStations.jsonl', 'npcStations.jsonl'],
    table: 'sde_stations',
    idField: 'station_id',
    nameField: 'name',
    extraCols: { system_id: 'system_id' },
    nameFromTypeIdField: 'type_id',
  },
  {
    filePatterns: ['npcCorporations.jsonl'],
    table: 'sde_npc_corporations',
    idField: 'corporation_id',
    nameField: 'name',
    extraCols: { station_id: 'station_id' },
  },
  {
    filePatterns: ['mapStargates.jsonl'],
    table: 'sde_stargates',
    idField: 'stargate_id',
    extraCols: {
      system_id: 'solar_system_id',
      destination_system_id: 'destination.solar_system_id',
      destination_stargate_id: 'destination.stargate_id',
    },
  },
  {
    filePatterns: ['blueprints.jsonl'],
    table: 'sde_blueprints',
    idField: 'blueprint_type_id',
    nameField: 'name',
    nameFromTypeIdField: 'blueprint_type_id',
  },
];

const GENERIC_NAME_FIELDS = [
  'name',
  'display_name',
  'displayName',
  'internal_name',
  'internalName',
  'operation_name',
  'operationName',
  'service_name',
  'serviceName',
  'graphic_file',
  'graphicFile',
  'icon_file',
  'iconFile',
] as const;

/**
 * Extract English name from a localized name field.
 * Post-Sep-2025 SDE format: name can be:
 *   - A localized object: {"en": "Tritanium", "ru": "Тританиум", ...}
 *   - A plain string (older format or simple fields)
 *   - Undefined/null
 */
function extractName(nameField: unknown): string {
  if (typeof nameField === 'string') return nameField;
  if (nameField && typeof nameField === 'object') {
    const localized = nameField as Record<string, string>;
    return localized['en'] ?? localized['en-us'] ?? Object.values(localized)[0] ?? '';
  }
  return '';
}

function getFieldValue(obj: Record<string, unknown>, field: string): unknown {
  if (field.includes('.')) {
    return field.split('.').reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
      return getFieldValue(current as Record<string, unknown>, part);
    }, obj);
  }

  if (field in obj) return obj[field];

  const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  if (camel in obj) return obj[camel];

  const camelId = camel.replace(/Id$/, 'ID');
  if (camelId in obj) return obj[camelId];

  if (field === 'system_id' && 'solarSystemID' in obj) return obj.solarSystemID;
  if (field === 'solar_system_id' && 'solarSystemID' in obj) return obj.solarSystemID;
  if (field === 'type_id' && 'typeID' in obj) return obj.typeID;
  if (field === 'blueprint_type_id' && 'blueprintTypeID' in obj) return obj.blueprintTypeID;
  if (field === 'station_id' && 'stationID' in obj) return obj.stationID;
  if (field === 'corporation_id' && 'corporationID' in obj) return obj.corporationID;
  if (field === 'certificate_id' && 'certificateID' in obj) return obj.certificateID;
  if (field === 'stargate_id' && 'stargateID' in obj) return obj.stargateID;
  if (field === 'destination_stargate_id' && 'destinationStargateID' in obj) return obj.destinationStargateID;
  if (field === 'destination_system_id' && 'destinationSystemID' in obj) return obj.destinationSystemID;

  return undefined;
}

/**
 * Find a JSONL file by trying multiple possible names.
 * Searches recursively up to 4 levels deep (CCP zips can nest: sde/fsd/universe/...).
 */
function findJsonlFile(sdeDir: string, patterns: string[]): string | null {
  // Try direct match first
  for (const pattern of patterns) {
    const direct = join(sdeDir, pattern);
    if (existsSync(direct)) return direct;
  }

  // Recursive search up to 4 levels deep
  function searchDir(dir: string, depth: number): string | null {
    if (depth > 4) return null;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        // Check if this entry matches any pattern
        for (const pattern of patterns) {
          if (entry === pattern) return fullPath;
        }
        // Recurse into subdirectories
        try {
          if (statSync(fullPath).isDirectory()) {
            const found = searchDir(fullPath, depth + 1);
            if (found) return found;
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    } catch (err) {
      console.warn(`[sde-loader] Cannot read directory ${dir}: ${(err as Error).message}`);
    }
    return null;
  }

  return searchDir(sdeDir, 0);
}

export async function loadJsonlFile(
  db: ReturnType<typeof initDb>,
  loader: LoaderConfig,
  sdeDir: string,
  typeNameMap?: Map<number, string>,
): Promise<{ count: number; filePath: string | null }> {
  const filePath = findJsonlFile(sdeDir, loader.filePatterns);
  if (!filePath) {
    console.log(`  [skip] ${loader.filePatterns.join(' / ')} -- not found`);
    return { count: 0, filePath: null };
  }

  console.log(`  [load] ${basename(filePath)} from ${filePath}`);

  // Build INSERT statement
  const hasName = Boolean(loader.nameField || loader.nameFromTypeIdField);
  const cols = [loader.idField];
  const placeholders = ['?'];
  if (hasName) {
    cols.push('name');
    placeholders.push('?');
  }
  const extraKeys = Object.keys(loader.extraCols ?? {});
  for (const col of extraKeys) {
    cols.push(col);
    placeholders.push('?');
  }
  cols.push('data_json');
  placeholders.push('?');

  const sql = `INSERT OR REPLACE INTO ${loader.table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
  const stmt = db.prepare(sql);

  // Clear existing data
  db.prepare(`DELETE FROM ${loader.table}`).run();

  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

  let count = 0;
  let skipped = 0;
  const insertMany = db.transaction((rows: unknown[][]) => {
    for (const row of rows) {
      stmt.run(...row);
    }
  });

  const batch: unknown[][] = [];
  const BATCH_SIZE = 1000;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      // Extract ID -- try the configured field, also try common alternatives
      let id = getFieldValue(obj, loader.idField);
      if (id === undefined && obj._key !== undefined) {
        id = obj._key;
      }
      if (id === undefined) continue; // skip records without valid ID
      // A non-scalar id (e.g. {"type_id": {...}}) can't bind to an INTEGER
      // PRIMARY KEY and would otherwise throw at flush time — outside the
      // per-line try — crashing the whole load with the table already cleared.
      if (typeof id === 'object') { skipped++; continue; }

      // Extract name -- handle localized format
      let name = '';
      if (loader.nameField) {
        name = extractName(obj[loader.nameField]);
      }
      if (!name && loader.nameFromTypeIdField && typeNameMap) {
        const typeId = getFieldValue(obj, loader.nameFromTypeIdField) ?? obj._key;
        const typeName = typeof typeId === 'number' ? typeNameMap.get(typeId) : undefined;
        if (typeName) {
          name = typeName;
        }
      }

      const row: unknown[] = [id];
      if (hasName) {
        row.push(name);
      }
      for (const col of extraKeys) {
        const jsonField = loader.extraCols![col];
        const val = getFieldValue(obj, jsonField);
        // Non-scalar values can't bind — store null rather than throwing.
        row.push(val !== null && typeof val === 'object' ? null : (val ?? null));
      }
      row.push(JSON.stringify(obj));

      batch.push(row);
      count++;

      if (batch.length >= BATCH_SIZE) {
        try {
          insertMany(batch.splice(0));
        } catch (err) {
          console.warn(`  [warn] ${basename(filePath)}: batch insert failed: ${(err as Error).message}`);
          skipped += BATCH_SIZE;
          count -= BATCH_SIZE;
        }
      }
    } catch {
      skipped++;
    }
  }

  if (batch.length > 0) {
    // Guard the final flush too — it is outside the per-line try above.
    try {
      insertMany(batch);
    } catch (err) {
      console.warn(`  [warn] ${basename(filePath)}: final batch insert failed: ${(err as Error).message}`);
      skipped += batch.length;
      count -= batch.length;
    }
  }

  if (skipped > 0) {
    console.warn(`  [warn] ${basename(filePath)}: ${skipped} lines skipped (malformed)`);
  }
  return { count, filePath };
}

function listJsonlFiles(rootDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 4) return;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (stat.isFile() && entry.endsWith('.jsonl')) {
          results.push(fullPath);
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }

  walk(rootDir, 0);
  return results;
}

function inferGenericName(obj: Record<string, unknown>): string | null {
  for (const field of GENERIC_NAME_FIELDS) {
    const raw = getFieldValue(obj, field);
    const name = extractName(raw);
    if (name) return name;
  }
  return null;
}

async function loadGenericJsonlFile(
  db: ReturnType<typeof initDb>,
  datasetName: string,
  filePath: string,
): Promise<number> {
  console.log(`  [load] ${basename(filePath)} into sde_raw_records`);
  db.prepare('DELETE FROM sde_raw_records WHERE dataset_name = ?').run(datasetName);

  const stmt = db.prepare(
    'INSERT OR REPLACE INTO sde_raw_records (dataset_name, record_id, name, data_json) VALUES (?, ?, ?, ?)'
  );
  const insertMany = db.transaction((rows: Array<[string, string, string | null, string]>) => {
    for (const row of rows) {
      stmt.run(...row);
    }
  });

  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  const batch: Array<[string, string, string | null, string]> = [];
  const BATCH_SIZE = 1000;
  let count = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const rawId = obj._key ?? getFieldValue(obj, 'id') ?? getFieldValue(obj, 'type_id') ?? getFieldValue(obj, 'item_id');
      if (rawId === undefined || rawId === null) continue;
      batch.push([datasetName, String(rawId), inferGenericName(obj), JSON.stringify(obj)]);
      count += 1;
      if (batch.length >= BATCH_SIZE) {
        insertMany(batch.splice(0));
      }
    } catch {
      // ignore malformed lines
    }
  }

  if (batch.length > 0) {
    insertMany(batch);
  }

  return count;
}

async function main() {
  const sdeDir = SDE_DATA_DIR;
  console.log(`[sde-loader] Loading SDE from ${sdeDir}`);

  if (!existsSync(sdeDir)) {
    console.error(`[sde-loader] Directory not found: ${sdeDir}`);
    console.error('[sde-loader] Run "npm run sde:download" first.');
    process.exit(1);
  }

  const db = initDb(DB_PATH);
  runMigrations(db);

  let totalRecords = 0;
  let typeNameMap: Map<number, string> | undefined;
  const handledFiles = new Set<string>();

  for (const loader of LOADERS) {
    const { count, filePath } = await loadJsonlFile(db, loader, sdeDir, typeNameMap);
    if (count > 0) {
      console.log(`  [done] ${loader.table}: ${count} records`);
      totalRecords += count;
    }
    if (filePath) {
      handledFiles.add(filePath);
    }
    if (loader.table === 'sde_types') {
      const rows = db.prepare('SELECT type_id, name FROM sde_types').all() as Array<{ type_id: number; name: string }>;
      typeNameMap = new Map(rows.map((row) => [row.type_id, row.name]));
    }
  }

  const extraFiles = listJsonlFiles(sdeDir)
    .filter((filePath) => !handledFiles.has(filePath));

  for (const filePath of extraFiles) {
    const datasetName = basename(filePath, '.jsonl');
    const count = await loadGenericJsonlFile(db, datasetName, filePath);
    if (count > 0) {
      console.log(`  [done] sde_raw_records:${datasetName}: ${count} records`);
      totalRecords += count;
    }
  }

  // Update sde_meta
  db.prepare(
    `INSERT OR REPLACE INTO sde_meta (build_number, loaded_at) VALUES (?, datetime('now'))`
  ).run('manual-' + new Date().toISOString().slice(0, 10));

  // Fail loudly if a critical table is empty. These power the most common
  // queries (item/price lookups and route planning); a silent partial load
  // otherwise looks "done" but leaves the agent unable to answer basic
  // questions. Exit non-zero so `npm run setup` surfaces the problem.
  const CRITICAL_TABLES = ['sde_types', 'sde_systems', 'sde_groups', 'sde_regions'];
  const empty = CRITICAL_TABLES.filter((table) => {
    try {
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n === 0;
    } catch {
      return true;
    }
  });

  db.close();
  console.log(`[sde-loader] Done. Total: ${totalRecords} records loaded.`);

  if (empty.length > 0) {
    console.error(
      `[sde-loader] ERROR: critical tables empty after load: ${empty.join(', ')}. ` +
        'Check that the matching *.jsonl files downloaded correctly, then re-run `npm run setup`.',
    );
    process.exit(1);
  }
}

// Only run the full load when executed directly (npm run sde:load) — importing
// this module (e.g. for loadJsonlFile in tests) must not trigger a load or a
// process.exit.
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((err) => {
    console.error('[sde-loader] Error:', err);
    process.exit(1);
  });
}
