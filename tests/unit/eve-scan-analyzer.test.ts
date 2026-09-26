import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/eve-local/analyzer.js', () => ({ executeAnalyzeLocal: vi.fn() }));

import { executeAnalyzeScan } from '../../src/eve-scan/analyzer.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT INTO sde_categories (category_id, name, data_json) VALUES (?, ?, ?)').run(6, 'Ship', '{}');
  db.prepare('INSERT INTO sde_groups (group_id, name, category_id, data_json) VALUES (?, ?, ?, ?)')
    .run(25, 'Frigate', 6, '{}');
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)')
    .run(587, 'Rifter', 25, '{}');
});

afterEach(() => {
  db.close();
});

describe('analyze_scan D-Scan without a typeID column', () => {
  it('resolves the Type column, not the custom object name', async () => {
    const paste = [
      "Bob's Rifter\tRifter\t1,200 km",
      'Tackle one\tRifter\t8 AU',
    ].join('\n');

    const result = await executeAnalyzeScan(db as never, { paste, scan_type: 'dscan' }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, scan_type: 'dscan', total_objects: 2, resolved: 2 });
    expect(result.grid).toEqual({ on_grid: 1, off_grid: 1 });
  });

  it('still resolves two-column "Type<TAB>Distance" lines by the first column', async () => {
    const result = await executeAnalyzeScan(db as never, { paste: 'Rifter\t500 km', scan_type: 'dscan' }) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, resolved: 1 });
  });
});
