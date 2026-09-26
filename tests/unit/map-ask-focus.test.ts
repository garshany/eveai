import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { __testables } from '../../src/web/map-routes.js';
import {
  formatRadarSnapshot,
  recordRadarBubble,
  recordRadarFocus,
  resetRadarSnapshotsForTests,
} from '../../src/eve-map/radar-snapshot.js';
import type { BubblePayload } from '../../src/eve-map/bubble.js';
import { buildNativeAgentTools } from '../../src/agent/tools.js';

const { readAskFocus } = __testables;
const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const CHAR = 90000001;

afterEach(() => resetRadarSnapshotsForTests());

describe('Perimeter ask focus', () => {
  it('reads the selected system (falling back to the centred one) from the map context', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO sde_systems (system_id, name, data_json) VALUES (?, ?, ?)')
      .run(30002813, 'Tama', JSON.stringify({ securityStatus: 0.2785 }));

    expect(readAskFocus(db, { systemId: 30000142, selectedSystemId: 30002813 }))
      .toEqual({ systemId: 30002813, name: 'Tama', security: 0.3 });
    expect(readAskFocus(db, { systemId: 30002813, selectedSystemId: null }))
      .toEqual({ systemId: 30002813, name: 'Tama', security: 0.3 });
    // Unknown ids and junk are ignored rather than trusted.
    expect(readAskFocus(db, { selectedSystemId: 123 })).toBeNull();
    expect(readAskFocus(db, { selectedSystemId: '30002813' })).toBeNull();
    expect(readAskFocus(db, 'x')).toBeNull();
    db.close();
  });

  it('puts the selected system into the radar block the agent reads', () => {
    recordRadarFocus(CHAR, { systemId: 30002813, name: 'Tama', security: 0.3 }, NOW);
    expect(formatRadarSnapshot(CHAR, NOW)).toContain('Selected on the map: Tama (system_id=30002813, sec 0.3)');

    recordRadarBubble(CHAR, {
      originId: 1, radius: 3, systems: [], recentKills: [],
      verdict: { score: 0.1, band: 'calm', worstSystemId: null },
      pilotShip: null, builtAt: new Date(NOW).toISOString(),
    } as unknown as BubblePayload, NOW);
    const block = formatRadarSnapshot(CHAR, NOW) ?? '';
    expect(block).toContain('Perimeter radar');
    expect(block).toContain('Selected on the map: Tama');

    // A stale focus is dropped instead of steering answers forever.
    expect(formatRadarSnapshot(CHAR, NOW + 10 * 60_000)).toBeNull();
  });

  it('lets plan_route take a per-route avoid list', async () => {
    const tools = await buildNativeAgentTools('perimeter');
    const planRoute = tools.find((tool) => 'name' in tool && tool.name === 'plan_route') as unknown as {
      parameters: { properties: Record<string, unknown>; required: string[] };
    };
    expect(planRoute.parameters.properties.avoid).toBeDefined();
    expect(planRoute.parameters.required).toContain('avoid');
  });
});
