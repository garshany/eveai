import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  batchCharacterStats,
  getBattle,
  getCharacterIntel,
  getCharacterStats,
  getKillmailDetail,
  getKillmailFitting,
  getLeaderboard,
  listEntityActivity,
  listBattles,
  listSystemKills,
  searchKillmails,
} from '../../src/eve-kill/client.js';
import {
  parseEsiKillmail,
  parseKillmailDetail,
  parseKillmailSummary,
} from '../../src/eve-kill/normalize.js';

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe('EVE-KILL v1 normalization', () => {
  it('normalizes summary, ESI-shaped, and enriched detail payloads', () => {
    const summary = parseKillmailSummary({
      killmail_id: 1,
      killmail_time: '2026-07-13T10:00:00Z',
      solar_system_id: 30000142,
      victim_character_id: 11,
      victim_corporation_id: 12,
      ship_type_id: 13,
      final_blow_character_id: 22,
      attacker_count: 3,
    });
    const esi = parseEsiKillmail(esiKill(2, '2026-07-13T11:00:00Z'));
    const detail = parseKillmailDetail({
      killmail_id: 3,
      killmail_time: '2026-07-13T12:00:00Z',
      solar_system_id: 30000142,
      victim: {
        character_id: 11,
        ship_type_id: 13,
        position: { x: 10, y: 20, z: 30 },
      },
      attackers: [{ character_id: 22, final_blow: true }],
      items: [{ type_id: 34, quantity_dropped: 2, quantity_destroyed: 1 }],
    });

    expect(summary).toMatchObject({ killmailId: 1, attackerCount: 3, sourceShape: 'summary' });
    expect(esi).toMatchObject({
      killmailId: 2,
      position: { x: 1, y: 2, z: 3 },
      isSolo: true,
      sourceShape: 'esi',
    });
    expect(detail).toMatchObject({
      killmailId: 3,
      position: { x: 10, y: 20, z: 30 },
      sourceShape: 'detail',
    });
  });

  it('rejects malformed present optional fields and malformed victim.position', () => {
    expect(() => parseEsiKillmail({
      ...esiKill(4, '2026-07-13T12:00:00Z'),
      victim: {
        character_id: '11',
        ship_type_id: 13,
        damage_taken: 1,
      },
    })).toThrow('optional id field must be a positive integer');
    expect(() => parseEsiKillmail({
      ...esiKill(5, '2026-07-13T12:00:00Z'),
      victim: {
        ship_type_id: 13,
        damage_taken: 1,
        position: { x: 1, y: 2 },
      },
    })).toThrow('victim.position.z must be a finite number');
  });

  it('requires canonical ISO-8601 killmail timestamps with an explicit timezone', () => {
    for (const invalid of [
      '1',
      'July 13, 2026 12:00:00',
      '2026-07-13',
      '2026-07-13T12:00:00',
      '2026-02-30T12:00:00Z',
      '2026-07-13 12:00:00Z',
    ]) {
      expect(() => parseKillmailSummary({
        killmail_id: 99,
        killmail_time: invalid,
        solar_system_id: 30000142,
        victim_corporation_id: 12,
        ship_type_id: 13,
      })).toThrow('killmail_time must be a canonical ISO-8601 timestamp with an explicit timezone');
    }

    expect(parseKillmailSummary({
      killmail_id: 100,
      killmail_time: '2026-07-13T12:00:00.123456+03:00',
      solar_system_id: 30000142,
      victim_corporation_id: 12,
      ship_type_id: 13,
    }).killmailTime).toBe('2026-07-13T12:00:00.123456+03:00');
  });
});

describe('EVE-KILL v1 client limits', () => {
  it('splits search into seven-day windows and chunks every ID filter to fifteen', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementation(async (_input: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse({ data: [], pagination: { hasMore: false, cursor: null } });
    });
    const systemIds = Array.from({ length: 16 }, (_, index) => 30_000_000 + index);

    const result = await searchKillmails(db, {
      from: '2026-07-01T00:00:00Z',
      to: '2026-07-09T01:00:00Z',
      system_ids: systemIds,
    });

    expect(result.ok).toBe(true);
    expect(bodies).toHaveLength(4);
    for (const body of bodies) {
      expect((body.system_ids as number[]).length).toBeLessThanOrEqual(15);
      expect(Date.parse(String(body.to)) - Date.parse(String(body.from)))
        .toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    }
    if (!result.ok) throw new Error('expected successful search');
    expect(result.data.windows[0]?.from).toBe('2026-07-01T00:00:00.000Z');
    expect(result.data.windows.at(-1)?.to).toBe('2026-07-09T01:00:00.000Z');
    for (let index = 1; index < result.data.windows.length; index += 1) {
      expect(Date.parse(result.data.windows[index]!.from))
        .toBe(Date.parse(result.data.windows[index - 1]!.to) + 1);
    }
  });

  it('preserves dual-role semantics when combined activity contains the same kill on both sides', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      const activity = url.includes('/losses') ? 'losses' : 'kills';
      return jsonResponse({
        data: [{
          killmail_id: 44,
          killmail_time: '2026-07-13T12:00:00Z',
          solar_system_id: 30000142,
          victim_character_id: 77,
          victim_corporation_id: 88,
          final_blow_character_id: 77,
          ship_type_id: 587,
          attacker_count: 1,
          activity,
        }],
        pagination: { hasMore: false, cursor: null },
      });
    });

    const result = await listEntityActivity(db, 'character', 77, 'all', { limit: 10 });

    expect(result.ok && result.data.kills).toHaveLength(1);
    expect(result.ok && result.data.kills[0]?.activity).toBe('all');
    expect(result.ok && result.data.requestCount).toBe(2);
  });

  it('follows search cursors, deduplicates IDs, and sorts deterministically', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        data: [esiKill(2, '2026-07-13T11:00:00Z'), esiKill(1, '2026-07-13T10:00:00Z')],
        pagination: { hasMore: true, cursor: 77 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [esiKill(1, '2026-07-13T10:00:00Z'), esiKill(3, '2026-07-13T09:00:00Z')],
        pagination: { hasMore: false, cursor: null },
      }));

    const result = await searchKillmails(db, {
      from: '2026-07-13T00:00:00Z',
      to: '2026-07-14T00:00:00Z',
    }, { limit: 3 });

    expect(result.ok && result.data.kills.map((kill) => kill.killmailId)).toEqual([2, 1, 3]);
    expect(result.ok && result.data.requestCount).toBe(2);
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)) as Record<string, unknown>;
    expect(secondBody.after).toBe(77);
  });

  it('rejects malformed filters instead of silently broadening a search', async () => {
    const result = await searchKillmails(db, {
      from: '2026-07-13T00:00:00Z',
      to: '2026-07-14T00:00:00Z',
      system_ids: [0, 30000142],
    });

    expect(result).toEqual({ ok: false, error: 'system_ids must contain only positive integer IDs' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects search plans that exceed the bounded request budget before allocation or fetch', async () => {
    const thousand = (offset: number) => Array.from({ length: 1_000 }, (_, index) => offset + index + 1);
    const cartesian = await searchKillmails(db, {
      from: '2026-07-13T00:00:00Z',
      to: '2026-07-14T00:00:00Z',
      character_ids: thousand(1_000_000),
      corporation_ids: thousand(2_000_000),
      alliance_ids: thousand(3_000_000),
    });
    const longWindow = await searchKillmails(db, {
      from: '1000-01-01T00:00:00Z',
      to: '3000-01-01T00:00:00Z',
    });

    expect(cartesian).toEqual({ ok: false, error: 'search plan exceeds the bounded request budget' });
    expect(longWindow).toEqual({ ok: false, error: 'search plan exceeds the bounded request budget' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects dishonest pagination that claims more data without a cursor', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [],
      pagination: { hasMore: true, cursor: null },
    }));
    const result = await searchKillmails(db, {
      from: '2026-07-13T00:00:00Z',
      to: '2026-07-14T00:00:00Z',
    });

    expect(result).toEqual({
      ok: false,
      error: 'EVE-KILL invalid response: pagination cursor is required when hasMore is true',
    });
  });

  it('enforces the local result cap even when upstream returns too many rows', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [
        esiKill(1, '2026-07-13T10:00:00Z'),
        esiKill(2, '2026-07-13T11:00:00Z'),
        esiKill(3, '2026-07-13T12:00:00Z'),
      ],
      pagination: { hasMore: false, cursor: null },
    }));

    const result = await searchKillmails(db, {
      from: '2026-07-13T00:00:00Z',
      to: '2026-07-14T00:00:00Z',
    }, { limit: 2 });

    expect(result.ok && result.data.kills.map((kill) => kill.killmailId)).toEqual([3, 2]);
    expect(result.ok && result.data.truncated).toBe(true);
  });

  it('does not claim truncation when a newest-first list ends exactly at the local limit', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{
        killmail_id: 9,
        killmail_time: '2026-07-13T12:00:00Z',
        solar_system_id: 30000142,
        victim_corporation_id: 12,
        ship_type_id: 13,
        attacker_count: 1,
      }],
      pagination: { hasMore: false, cursor: null },
    }));

    const result = await listSystemKills(db, 30000142, { limit: 1 });

    expect(result.ok && result.data).toMatchObject({
      kills: [{ killmailId: 9 }],
      truncated: false,
      requestCount: 1,
    });
  });

  it('uses schema-versioned cache entries and reparses cached raw payloads', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      killmail_id: 91,
      killmail_time: '2026-07-13T12:00:00Z',
      solar_system_id: 30000142,
      victim: { character_id: 11, position: { x: 1, y: 2, z: 3 } },
      attackers: [],
    }));

    const first = await getKillmailDetail(db, 91);
    const second = await getKillmailDetail(db, 91);

    expect(first.ok && first.data.killmailId).toBe(91);
    expect(second.ok && second.data.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const cache = db.prepare('SELECT cache_key FROM esi_cache').get() as { cache_key: string };
    expect(cache.cache_key).toContain('evekill:v2:GET:killmails/91');
  });

  it('batches character stats and exposes response coverage', async () => {
    fetchMock.mockImplementation(async (_input: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { ids: number[] };
      return jsonResponse({
        period: 'weekly',
        results: body.ids.slice(0, body.ids.length === 100 ? 100 : 0).map((id) => ({
          id,
          kills: 1,
          losses: 0,
          solo_kills: 0,
          npc_losses: 0,
          isk_destroyed: 1,
          isk_lost: 0,
          topShips: [],
        })),
      });
    });
    const ids = Array.from({ length: 101 }, (_, index) => index + 1);

    const result = await batchCharacterStats(db, ids, { type: 'weekly' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok && result.data).toMatchObject({
      requestCount: 2,
      requestedIds: ids,
      resolvedIds: ids.slice(0, 100),
      missingIds: [101],
      truncated: true,
    });
  });

  it('validates and caps leaderboard and battle collections locally', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        entries: [
          { id: 1, name: 'A', count: 5, type: 'character' },
          { id: 2, name: 'B', count: 4, type: 'character' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [battleSummary(1), battleSummary(2)],
        pagination: { page: 1, limit: 1, hasMore: false },
      }));

    const leaderboard = await getLeaderboard(db, 'characters', 7, 1);
    const battles = await listBattles(db, { page: 1, limit: 1 });

    expect(leaderboard.ok && leaderboard.data).toEqual({
      entries: [{ id: 1, name: 'A', count: 5, type: 'character' }],
      truncated: true,
    });
    expect(battles.ok && battles.data).toMatchObject({
      data: [{ battle_id: 1 }],
      truncated: true,
    });
  });

  it('caps fitting and battle-detail arrays with explicit truncation', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        killmail_id: 77,
        ship: { type_id: 13, name: 'Ship' },
        cargo: Array.from({ length: 501 }, (_, index) => ({ type_id: index + 1, name: `Item ${index}`, quantity: 1 })),
      }))
      .mockResolvedValueOnce(jsonResponse({
        battle: battleSummary(88),
        teams: [{
          team_index: 0,
          total_kills: 1,
          total_losses: 1,
          total_isk_destroyed: 10,
          total_isk_lost: 10,
          members: [battleMember(1), battleMember(2)],
        }],
      }));

    const fitting = await getKillmailFitting(db, 77);
    const battle = await getBattle(db, 88, 1);

    expect(fitting.ok && (fitting.data.cargo as unknown[])).toHaveLength(500);
    expect(fitting.ok && fitting.data.truncated).toBe(true);
    expect(battle.ok && battle.data).toMatchObject({
      teams: [{ members: [{ corporation_id: 1 }] }],
      truncated: true,
    });
  });

  it('rejects malformed character-intel fields instead of passing through raw data', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      character_id: 5,
      days: 7,
      playstyle: { solo: 1, small_gang: 0, mid_gang: 0, fleet: 0, blob: 0, avg_fleet_size: 1, total_kills: 1 },
      dominant_style: 'Solo',
      tags: 'not-an-array',
      fc: { likelihood: 'None', monitor_appearances: 0 },
      capital_pilot: false,
      is_logi: false,
      ships_flown: [],
      ships_lost: [],
      targets: [],
      fleet_partners: [],
      groups_flown_with: [],
      awox_kills: 0,
      cyno_deaths: 0,
      bait: 'None',
      bait_count: 0,
      bridge_score: 0,
    }));

    const result = await getCharacterIntel(db, 5, 7);

    expect(result).toEqual({ ok: false, error: 'EVE-KILL invalid response: tags must be an array' });
  });

  it('rejects a reversed single-character stats range before fetch', async () => {
    const result = await getCharacterStats(db, 5, {
      type: 'range',
      from: '2026-07-14',
      to: '2026-07-13',
    });

    expect(result).toEqual({ ok: false, error: 'invalid character stats range' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function esiKill(id: number, time: string): Record<string, unknown> {
  return {
    killmail_id: id,
    killmail_hash: `hash-${id}`,
    killmail_time: time,
    solar_system_id: 30000142,
    victim: {
      character_id: 11,
      corporation_id: 12,
      ship_type_id: 13,
      damage_taken: 100,
      position: { x: 1, y: 2, z: 3 },
    },
    attackers: [{ character_id: 22, damage_done: 100, final_blow: true }],
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function battleSummary(id: number): Record<string, unknown> {
  return {
    battle_id: id,
    solar_system_id: 30000142,
    system_name: 'Jita',
    region_id: 10000002,
    region_name: 'The Forge',
    start_time: '2026-07-13T10:00:00Z',
    end_time: '2026-07-13T10:05:00Z',
    duration_minutes: 5,
    kill_count: 2,
    total_isk_destroyed: 10,
    is_multi_party: false,
    is_custom: false,
  };
}

function battleMember(id: number): Record<string, unknown> {
  return {
    corporation_id: id,
    corporation_name: `Corp ${id}`,
    corporation_ticker: `C${id}`,
    kills: 1,
    losses: 0,
    isk_destroyed: 10,
    isk_lost: 0,
  };
}
