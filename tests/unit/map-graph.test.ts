import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  bubbleFrom,
  buildMapGraph,
  getMapGraphMeta,
  invalidateMapGraphCache,
  jumpDistance,
  MapGraphBuildError,
  routeWithRisk,
} from '../../src/eve/map-graph.js';

/**
 * Граф: 30000001 — 30000002 — 30000003, плюс длинный безопасный обход
 * 30000001 — 30000004 — 30000005 — 30000003. Короткий путь идёт через
 * лоусек 30000002, длинный — целиком по хайсеку. На этой форме проверяются
 * и BFS-кольца, и компромисс «прыжки против опасности».
 */
const SYSTEMS: Array<{ id: number; name: string; security: number }> = [
  { id: 30000001, name: 'Origin', security: 0.9 },
  { id: 30000002, name: 'Lowsec', security: 0.3 },
  { id: 30000003, name: 'Target', security: 0.8 },
  { id: 30000004, name: 'DetourA', security: 0.7 },
  { id: 30000005, name: 'DetourB', security: 0.7 },
  { id: 30000006, name: 'Leaf', security: 1.0 },
];

const GATES: Array<[number, number]> = [
  [30000001, 30000002],
  [30000002, 30000003],
  [30000001, 30000004],
  [30000004, 30000005],
  [30000005, 30000003],
  [30000003, 30000006],
];

function seed(db: Database.Database, options: { withGeometry?: boolean } = {}): void {
  db.exec(SCHEMA_SQL);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sde_meta (build_number TEXT, loaded_at TEXT);
    CREATE TABLE IF NOT EXISTS sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, constellation_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_constellations (constellation_id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_regions (region_id INTEGER PRIMARY KEY, name TEXT, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_stargates (stargate_id INTEGER PRIMARY KEY, system_id INTEGER, destination_system_id INTEGER, destination_stargate_id INTEGER, data_json TEXT);
  `);
  db.prepare('INSERT INTO sde_meta (build_number, loaded_at) VALUES (?, ?)').run('1', '2026-01-01');
  db.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, ?, ?)').run(10000001, 'TestRegion', '{}');
  db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)')
    .run(20000001, 'TestConstellation', 10000001, '{}');

  const insert = db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)');
  for (const [index, system] of SYSTEMS.entries()) {
    const payload: Record<string, unknown> = { securityStatus: system.security };
    if (options.withGeometry !== false) {
      payload.position = { x: index * 100, y: 0, z: index * 50 };
      payload.position2D = { x: index * 10, y: index * 5 };
    }
    insert.run(system.id, system.name, 20000001, JSON.stringify(payload));
  }

  const gate = db.prepare(
    'INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [index, [from, to]] of GATES.entries()) {
    gate.run(50000000 + index, from, to, null, '{}');
  }
}

describe('map graph', () => {
  let db: Database.Database;

  beforeEach(() => {
    invalidateMapGraphCache();
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    invalidateMapGraphCache();
  });

  it('builds systems and a symmetric gate graph from the SDE', () => {
    seed(db);
    const result = buildMapGraph(db);

    expect(result.rebuilt).toBe(true);
    expect(result.meta.systemCount).toBe(SYSTEMS.length);
    // Каждая связка хранится в обе стороны, чтобы BFS не объединял два запроса.
    expect(result.meta.edgeCount).toBe(GATES.length * 2);
    expect(result.meta.geometrySource).toBe('position2D');
    expect(getMapGraphMeta(db)?.systemCount).toBe(SYSTEMS.length);
  });

  it('does not rebuild when the SDE build is unchanged', () => {
    seed(db);
    buildMapGraph(db);
    const second = buildMapGraph(db);
    expect(second.rebuilt).toBe(false);
    expect(second.reason).toBe('up_to_date');
  });

  it('rebuilds when the SDE build number changes', () => {
    seed(db);
    buildMapGraph(db);
    db.prepare('UPDATE sde_meta SET build_number = ?').run('2');
    const rebuilt = buildMapGraph(db);
    expect(rebuilt.rebuilt).toBe(true);
    expect(rebuilt.reason).toBe('sde_changed');
  });

  it('rebuilds after a reload that appends a newer sde_meta row', () => {
    // Regression: the reader took an unordered LIMIT 1, so once a second SDE
    // load appended a newer build row (rather than replacing), the graph kept
    // reading the oldest build number and never rebuilt against the new data.
    seed(db);
    buildMapGraph(db);
    db.prepare('INSERT INTO sde_meta (build_number, loaded_at) VALUES (?, ?)').run('2', '2026-06-01');
    const rebuilt = buildMapGraph(db);
    expect(rebuilt.rebuilt).toBe(true);
    expect(rebuilt.reason).toBe('sde_changed');
  });

  it('refuses to build a map when no system carries coordinates', () => {
    seed(db, { withGeometry: false });
    // Пустая карта хуже упавшей сборки: все системы оказались бы в одной точке.
    expect(() => buildMapGraph(db)).toThrow(MapGraphBuildError);
  });

  it('falls back to the 3D position when position2D is absent', () => {
    seed(db);
    db.exec("UPDATE sde_systems SET data_json = json_remove(data_json, '$.position2D')");
    const result = buildMapGraph(db, { force: true });
    expect(result.meta.geometrySource).toBe('position3D');
  });

  describe('bubble', () => {
    beforeEach(() => {
      seed(db);
      buildMapGraph(db);
    });

    it('groups systems by jump distance', () => {
      const bubble = bubbleFrom(db, 30000001, 3, 100);
      const jumps = new Map(bubble.nodes.map((node) => [node.systemId, node.jumps]));

      expect(jumps.get(30000001)).toBe(0);
      expect(jumps.get(30000002)).toBe(1);
      expect(jumps.get(30000004)).toBe(1);
      expect(jumps.get(30000003)).toBe(2);
      expect(jumps.get(30000005)).toBe(2);
      expect(bubble.truncated).toBe(false);
    });

    it('reports the radius that actually fit when the node cap stops it', () => {
      const bubble = bubbleFrom(db, 30000001, 5, 3);

      expect(bubble.truncated).toBe(true);
      expect(bubble.requestedRadius).toBe(5);
      expect(bubble.radius).toBeLessThan(5);
      // Кольцо принимается целиком: у каждого возвращённого узла дистанция верна.
      for (const node of bubble.nodes) {
        expect(node.jumps).toBeLessThanOrEqual(bubble.radius);
      }
    });

    it('returns an empty bubble for an unknown origin', () => {
      const bubble = bubbleFrom(db, 42, 3, 100);
      expect(bubble.nodes).toHaveLength(0);
      expect(bubble.edges).toHaveLength(0);
    });

    it('emits each undirected edge once', () => {
      const bubble = bubbleFrom(db, 30000001, 5, 100);
      const seen = new Set(bubble.edges.map(([a, b]) => `${a}:${b}`));
      expect(seen.size).toBe(bubble.edges.length);
      for (const [a, b] of bubble.edges) expect(a).toBeLessThan(b);
    });

    it('measures jump distance across the graph', () => {
      expect(jumpDistance(db, 30000001, 30000003)).toBe(2);
      expect(jumpDistance(db, 30000001, 30000001)).toBe(0);
      expect(jumpDistance(db, 30000001, 999)).toBeNull();
    });
  });

  describe('risk routing', () => {
    beforeEach(() => {
      seed(db);
      buildMapGraph(db);
    });

    it('equals the shortest path when the risk weight is zero', () => {
      const route = routeWithRisk(db, 30000001, 30000003, { riskWeight: 0 });
      expect(route.ok).toBe(true);
      expect(route.jumps).toBe(2);
      expect(route.systemIds).toEqual([30000001, 30000002, 30000003]);
    });

    it('trades jumps for safety when the risk weight is raised', () => {
      const dangerOf = (systemId: number): number => (systemId === 30000002 ? 1 : 0);
      const route = routeWithRisk(db, 30000001, 30000003, { riskWeight: 10, dangerOf });

      expect(route.ok).toBe(true);
      expect(route.systemIds).toEqual([30000001, 30000004, 30000005, 30000003]);
      expect(route.jumps).toBe(3);
    });

    it('explains every hop', () => {
      const route = routeWithRisk(db, 30000001, 30000003, {
        riskWeight: 5,
        dangerOf: (systemId) => (systemId === 30000002 ? 0.5 : 0),
      });
      // Маршрут без разбора стоимости — это утверждение без доказательства.
      expect(route.hops[0]!.terms).toEqual([]);
      for (const hop of route.hops.slice(1)) {
        expect(hop.terms.some((term) => term.label === 'jump')).toBe(true);
      }
    });

    it('penalizes leaving highsec in secure mode without banning it', () => {
      const secure = routeWithRisk(db, 30000001, 30000003, { mode: 'secure' });
      expect(secure.ok).toBe(true);
      // Обход дороже по прыжкам, но не выходит из хайсека.
      expect(secure.systemIds).toEqual([30000001, 30000004, 30000005, 30000003]);
    });

    it('still returns a route when only an unsafe path exists', () => {
      const isolated = new Database(':memory:');
      seed(isolated);
      // Оставляем единственный путь — через лоусек.
      isolated.exec('DELETE FROM sde_stargates WHERE system_id IN (30000004, 30000005) OR destination_system_id IN (30000004, 30000005)');
      invalidateMapGraphCache();
      buildMapGraph(isolated, { force: true });

      const route = routeWithRisk(isolated, 30000001, 30000003, { mode: 'secure' });
      expect(route.ok).toBe(true);
      expect(route.systemIds).toContain(30000002);
      isolated.close();
      invalidateMapGraphCache();
    });

    it('honours the avoid set', () => {
      const route = routeWithRisk(db, 30000001, 30000003, { avoid: [30000002] });
      expect(route.systemIds).toEqual([30000001, 30000004, 30000005, 30000003]);
    });

    it('refuses when the destination itself is avoided', () => {
      const route = routeWithRisk(db, 30000001, 30000003, { avoid: [30000003] });
      expect(route.ok).toBe(false);
      expect(route.error).toContain('avoid');
    });

    it('reports an unreachable destination instead of inventing a path', () => {
      const isolated = new Database(':memory:');
      seed(isolated);
      isolated.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)')
        .run(30000099, 'Island', 20000001, JSON.stringify({ securityStatus: 0.5, position2D: { x: 1, y: 1 } }));
      invalidateMapGraphCache();
      buildMapGraph(isolated, { force: true });

      const route = routeWithRisk(isolated, 30000001, 30000099);
      expect(route.ok).toBe(false);
      expect(route.error).toContain('No gate route');
      isolated.close();
      invalidateMapGraphCache();
    });

    it('can traverse supplied wormhole edges', () => {
      const route = routeWithRisk(db, 30000001, 30000003, {
        avoid: [30000002, 30000004],
        extraEdges: [[30000001, 30000003]],
      });
      expect(route.ok).toBe(true);
      expect(route.systemIds).toEqual([30000001, 30000003]);
    });
  });
});
