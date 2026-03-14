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

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { config } from '../config.js';
import { initDb } from '../db/sqlite.js';
import { runMigrations } from '../db/migrations.js';

interface LoaderConfig {
  /** Possible file names to look for (without path) */
  filePatterns: string[];
  table: string;
  idField: string;
  nameField: string;
  /** Additional columns to extract from JSON into separate DB columns */
  extraCols?: Record<string, string>; // column_name -> json_field
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
    filePatterns: ['dogmaAttributes.jsonl', 'dogma_attributes.jsonl'],
    table: 'sde_dogma_attributes',
    idField: 'attribute_id',
    nameField: 'name',
  },
  {
    filePatterns: ['dogmaEffects.jsonl', 'dogma_effects.jsonl'],
    table: 'sde_dogma_effects',
    idField: 'effect_id',
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
    filePatterns: ['stations.jsonl', 'staStations.jsonl'],
    table: 'sde_stations',
    idField: 'station_id',
    nameField: 'name',
    extraCols: { system_id: 'system_id' },
  },
  {
    filePatterns: ['blueprints.jsonl'],
    table: 'sde_blueprints',
    idField: 'blueprint_type_id',
    nameField: 'name',
  },
];

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

async function loadJsonlFile(
  db: ReturnType<typeof initDb>,
  loader: LoaderConfig,
  sdeDir: string,
): Promise<number> {
  const filePath = findJsonlFile(sdeDir, loader.filePatterns);
  if (!filePath) {
    console.log(`  [skip] ${loader.filePatterns.join(' / ')} -- not found`);
    return 0;
  }

  console.log(`  [load] ${basename(filePath)} from ${filePath}`);

  // Build INSERT statement
  const cols = [loader.idField, 'name'];
  const placeholders = ['?', '?'];
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
      let id = obj[loader.idField];
      if (id === undefined) {
        // Try alternative field names (CCP sometimes uses typeID vs type_id etc.)
        const camelCase = loader.idField.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        id = obj[camelCase];
      }
      if (id === undefined) continue; // skip records without valid ID

      // Extract name -- handle localized format
      const name = extractName(obj[loader.nameField]);

      const row: unknown[] = [id, name];
      for (const col of extraKeys) {
        const jsonField = loader.extraCols![col];
        let val = obj[jsonField];
        if (val === undefined) {
          // Try camelCase alternative
          const camelCase = jsonField.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
          val = obj[camelCase];
        }
        row.push(val ?? null);
      }
      row.push(JSON.stringify(obj));

      batch.push(row);
      count++;

      if (batch.length >= BATCH_SIZE) {
        insertMany(batch.splice(0));
      }
    } catch {
      skipped++;
    }
  }

  if (batch.length > 0) {
    insertMany(batch);
  }

  if (skipped > 0) {
    console.warn(`  [warn] ${basename(filePath)}: ${skipped} lines skipped (malformed)`);
  }
  return count;
}

async function main() {
  const sdeDir = config.sde.dataDir;
  console.log(`[sde-loader] Loading SDE from ${sdeDir}`);

  if (!existsSync(sdeDir)) {
    console.error(`[sde-loader] Directory not found: ${sdeDir}`);
    console.error('[sde-loader] Run "npm run sde:download" first.');
    process.exit(1);
  }

  const db = initDb(config.db.path);
  runMigrations(db);

  let totalRecords = 0;

  for (const loader of LOADERS) {
    const count = await loadJsonlFile(db, loader, sdeDir);
    if (count > 0) {
      console.log(`  [done] ${loader.table}: ${count} records`);
      totalRecords += count;
    }
  }

  // Update sde_meta
  db.prepare(
    `INSERT OR REPLACE INTO sde_meta (build_number, loaded_at) VALUES (?, datetime('now'))`
  ).run('manual-' + new Date().toISOString().slice(0, 10));

  db.close();
  console.log(`[sde-loader] Done. Total: ${totalRecords} records loaded.`);
}

main().catch((err) => {
  console.error('[sde-loader] Error:', err);
  process.exit(1);
});
