import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 0 },
    openai: { apiKey: 'test', model: 'test' },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
  },
}));

import { loadJsonlFile } from '../../src/eve/sde-loader.js';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  dir = mkdtempSync(join(tmpdir(), 'sde-loader-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('loadJsonlFile robustness', () => {
  it('loads valid rows and skips malformed / non-scalar-id lines without crashing', async () => {
    const lines = [
      JSON.stringify({ type_id: 34, name: 'Tritanium', group_id: 18 }),
      'this is not json',                                   // malformed → skip
      JSON.stringify({ name: 'no id here', group_id: 5 }),  // missing id → skip
      JSON.stringify({ type_id: { nested: true }, name: 'bad id', group_id: 9 }), // object id → skip (was a crash)
      JSON.stringify({ type_id: 587, name: 'Rifter', group_id: { weird: 1 } }),   // object extra-col → null
      JSON.stringify({ type_id: 35, name: 'Pyerite', group_id: 18 }),
    ];
    writeFileSync(join(dir, 'types.jsonl'), lines.join('\n'));

    // Must not throw even though one line has an object-valued id.
    const result = await loadJsonlFile(db as never, {
      filePatterns: ['types.jsonl'],
      table: 'sde_types',
      idField: 'type_id',
      nameField: 'name',
      extraCols: { group_id: 'group_id' },
    }, dir);

    // Three valid ids loaded (34, 587, 35); malformed/no-id/object-id skipped.
    const rows = db.prepare('SELECT type_id, group_id FROM sde_types ORDER BY type_id').all() as Array<{ type_id: number; group_id: number | null }>;
    expect(rows.map((r) => r.type_id)).toEqual([34, 35, 587]);
    expect(result.count).toBe(3);

    // The object-valued group_id is stored as null, not a crash or a JSON blob.
    const rifter = rows.find((r) => r.type_id === 587);
    expect(rifter?.group_id).toBeNull();

    // The table is populated (not wiped by a mid-load crash).
    const total = db.prepare('SELECT COUNT(*) AS n FROM sde_types').get() as { n: number };
    expect(total.n).toBe(3);
  });
});
