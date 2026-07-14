import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const esiMocks = vi.hoisted(() => ({
  callEsiOperation: vi.fn(),
  deliverOutbound: vi.fn(),
  getAccessToken: vi.fn(),
  getCapabilities: vi.fn(),
  getUserOutboundChatId: vi.fn(),
  runModelText: vi.fn(),
}));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: esiMocks.callEsiOperation,
  pruneExpiredEsiCache: vi.fn(() => 0),
}));

vi.mock('../../src/messaging/outbound.js', () => ({
  deliverOutbound: esiMocks.deliverOutbound,
}));

vi.mock('../../src/eve/sso.js', () => ({
  getAccessToken: esiMocks.getAccessToken,
}));

vi.mock('../../src/eve/capabilities.js', () => ({
  getEveCapabilities: esiMocks.getCapabilities,
}));

vi.mock('../../src/auth/user-resolver.js', () => ({
  getUserOutboundChatId: esiMocks.getUserOutboundChatId,
}));

vi.mock('../../src/agent/model.js', () => ({
  runModelText: esiMocks.runModelText,
}));

import { checkKillmails, processUserHeartbeat } from '../../src/scheduled/heartbeat-worker.js';
import type { HeartbeatConfigRow } from '../../src/scheduled/heartbeat-config.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare(
    'INSERT INTO sde_types (type_id, name, data_json) VALUES (?, ?, ?)',
  ).run(587, 'Rifter', '{}');
  db.prepare(
    'INSERT INTO sde_systems (system_id, name, data_json) VALUES (?, ?, ?)',
  ).run(30000142, 'Jita', '{}');
  esiMocks.callEsiOperation.mockReset();
  esiMocks.deliverOutbound.mockReset();
  esiMocks.getAccessToken.mockReset();
  esiMocks.getCapabilities.mockReset();
  esiMocks.getUserOutboundChatId.mockReset();
  esiMocks.runModelText.mockReset();
});

afterEach(() => {
  db.close();
});

describe('heartbeat killmail source boundary', () => {
  it('seeds from official recent references without resolving historical details', async () => {
    esiMocks.callEsiOperation.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: [{ killmail_id: 100, killmail_hash: 'official-hash-100' }],
    });
    const state: Record<string, unknown> = {};

    const result = await checkKillmails(db, { userId: 7 }, 9001, state);

    expect(result).toBeNull();
    expect(state.last_killmail_id).toBe(100);
    expect(esiMocks.callEsiOperation).toHaveBeenCalledTimes(1);
    expect(esiMocks.callEsiOperation).toHaveBeenCalledWith(
      db,
      'get_characters_character_id_killmails_recent',
      { character_id: 9001 },
      { userId: 7 },
    );
  });

  it('resolves every new reference through official ESI with its exact id and hash', async () => {
    esiMocks.callEsiOperation
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: [{ killmail_id: 101, killmail_hash: 'official-hash-101' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          victim: { character_id: 9001, ship_type_id: 587 },
          solar_system_id: 30000142,
          killmail_time: '2026-07-13T18:00:00Z',
        },
      });
    const state: Record<string, unknown> = { last_killmail_id: 100 };

    const result = await checkKillmails(db, { userId: 7 }, 9001, state);

    expect(result).toContain('Потерян Rifter в Jita');
    expect(state.last_killmail_id).toBe(101);
    expect(esiMocks.callEsiOperation).toHaveBeenNthCalledWith(
      2,
      db,
      'get_killmails_killmail_id_killmail_hash',
      { killmail_id: 101, killmail_hash: 'official-hash-101' },
      { userId: 7 },
    );
    expect(esiMocks.callEsiOperation.mock.calls.map((call) => call[1])).toEqual([
      'get_characters_character_id_killmails_recent',
      'get_killmails_killmail_id_killmail_hash',
    ]);
  });

  it('resolves all new official references before advancing even when the summary is capped', async () => {
    const references = Array.from({ length: 5 }, (_, index) => ({
      killmail_id: 101 + index,
      killmail_hash: `official-hash-${101 + index}`,
    }));
    esiMocks.callEsiOperation.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: references,
    });
    for (const _reference of references) {
      esiMocks.callEsiOperation.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          victim: { character_id: 9001, ship_type_id: 587 },
          solar_system_id: 30000142,
          killmail_time: '2026-07-13T18:00:00Z',
        },
      });
    }
    const state: Record<string, unknown> = { last_killmail_id: 100 };

    const result = await checkKillmails(db, { userId: 7 }, 9001, state);

    expect(result).toContain('[KILLMAILS] 5 новых');
    expect(result).toContain('...и ещё 2');
    expect(state.last_killmail_id).toBe(105);
    expect(esiMocks.callEsiOperation).toHaveBeenCalledTimes(6);
    expect(esiMocks.callEsiOperation.mock.calls.slice(1).map((call) => call[2])).toEqual(
      [...references].reverse().map((reference) => ({
        killmail_id: reference.killmail_id,
        killmail_hash: reference.killmail_hash,
      })),
    );
  });

  it('fails closed when official ESI is unavailable', async () => {
    esiMocks.callEsiOperation.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: 'temporary ESI failure',
    });
    const state: Record<string, unknown> = { last_killmail_id: 100 };

    await expect(checkKillmails(db, { userId: 7 }, 9001, state)).resolves.toBeNull();

    expect(state.last_killmail_id).toBe(100);
    expect(esiMocks.callEsiOperation).toHaveBeenCalledTimes(1);
  });

  it('leaves the initial cursor unset when the first official ESI request fails', async () => {
    esiMocks.callEsiOperation.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: 'temporary ESI failure',
    });
    const state: Record<string, unknown> = {};

    await expect(checkKillmails(db, { userId: 7 }, 9001, state)).resolves.toBeNull();

    expect(state).not.toHaveProperty('last_killmail_id');
  });

  it('does not advance past a reference whose official detail failed', async () => {
    esiMocks.callEsiOperation
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: [{ killmail_id: 101, killmail_hash: 'official-hash-101' }],
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        error: 'official detail unavailable',
      });
    const state: Record<string, unknown> = { last_killmail_id: 100 };

    await expect(checkKillmails(db, { userId: 7 }, 9001, state)).resolves.toBeNull();

    expect(state.last_killmail_id).toBe(100);
  });

  it('persists a finding cursor only after awaited outbound delivery succeeds', async () => {
    db.prepare(`
      INSERT INTO heartbeat_config
        (user_id, character_id, enabled, interval_seconds, checks_json, state_json)
      VALUES (?, ?, 1, 300, ?, ?)
    `).run(7, 9001, '["killmails"]', '{"last_killmail_id":100}');
    const row = db.prepare('SELECT * FROM heartbeat_config WHERE user_id = 7 AND character_id = 9001')
      .get() as HeartbeatConfigRow;
    esiMocks.getUserOutboundChatId.mockReturnValue(77);
    esiMocks.getAccessToken.mockResolvedValue('access-token-present');
    esiMocks.getCapabilities.mockResolvedValue({ linked: true });
    esiMocks.runModelText.mockResolvedValue('heartbeat summary');
    esiMocks.deliverOutbound.mockRejectedValue(new Error('gateway unavailable'));
    esiMocks.callEsiOperation
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: [{ killmail_id: 101, killmail_hash: 'official-hash-101' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          victim: { character_id: 9001, ship_type_id: 587 },
          solar_system_id: 30000142,
          killmail_time: '2026-07-13T18:00:00Z',
        },
      });

    await expect(processUserHeartbeat(db, row, '2026-07-13 18:05:00'))
      .rejects.toThrow('gateway unavailable');

    const persisted = db.prepare(
      'SELECT state_json, last_run_at FROM heartbeat_config WHERE user_id = 7 AND character_id = 9001',
    ).get() as { state_json: string; last_run_at: string | null };
    expect(JSON.parse(persisted.state_json)).toEqual({ last_killmail_id: 100 });
    expect(persisted.last_run_at).toBeNull();
    expect(esiMocks.deliverOutbound).toHaveBeenCalledWith(77, 'heartbeat summary');
  });
});
