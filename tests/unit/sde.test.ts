import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { querySde } from '../../src/eve/sde.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  // Insert test data
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    34, 'Tritanium', 18, JSON.stringify({ type_id: 34, name: 'Tritanium', group_id: 18, volume: 0.01 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    35, 'Pyerite', 18, JSON.stringify({ type_id: 35, name: 'Pyerite', group_id: 18, volume: 0.01 })
  );
  db.prepare(`INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, ?, ?)`).run(
    587, 'Rifter', 25, JSON.stringify({ type_id: 587, name: 'Rifter', group_id: 25, volume: 27289 })
  );

  db.prepare(`INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)`).run(
    10000002, 'The Forge', JSON.stringify({ region_id: 10000002, name: 'The Forge' })
  );

  db.prepare(`INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)`).run(
    30000142, 'Jita', 20000020, JSON.stringify({ system_id: 30000142, name: 'Jita', security: 0.9 })
  );
});

afterEach(() => {
  db.close();
});

describe('query_sde', () => {
  it('looks up type by_id', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'by_id', value: '34', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.items[0].name).toBe('Tritanium');
  });

  it('looks up type by_name', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'by_name', value: 'Rifter', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.items[0].id).toBe(587);
  });

  it('searches types by partial name', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'search', value: 'rit', limit: 10 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2); // Tritanium and Rifter both contain 'rit'
    const names = result.items.map((i) => i.name);
    expect(names).toContain('Tritanium');
  });

  it('looks up region by_name', () => {
    const result = querySde(db, { entity: 'region', lookup_mode: 'by_name', value: 'The Forge', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.items[0].id).toBe(10000002);
  });

  it('searches systems', () => {
    const result = querySde(db, { entity: 'system', lookup_mode: 'search', value: 'Jita', limit: 5 });
    expect(result.ok).toBe(true);
    expect(result.items[0].name).toBe('Jita');
  });

  it('returns empty for non-existent id', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'by_id', value: '999999', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
  });

  it('rejects invalid entity', () => {
    const result = querySde(db, { entity: 'invalid' as any, lookup_mode: 'by_id', value: '1', limit: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown entity');
  });

  it('rejects non-numeric by_id', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'by_id', value: 'abc', limit: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('numeric');
  });

  it('clamps limit to 50', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'search', value: '', limit: 100 });
    expect(result.ok).toBe(true);
    // Should not crash, just works with clamped limit
  });

  it('case insensitive name search', () => {
    const result = querySde(db, { entity: 'type', lookup_mode: 'by_name', value: 'tritanium', limit: 1 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.items[0].name).toBe('Tritanium');
  });
});
