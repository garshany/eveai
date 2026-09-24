import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import type { NormalizedKillmail } from '../../src/eve-kill/types.js';

const feedMocks = vi.hoisted(() => {
  let listener: ((event: unknown) => void) | null = null;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((handler: (event: unknown) => void) => {
    listener = handler;
    return unsubscribe;
  });
  return {
    unsubscribe,
    subscribe,
    emit: (killmail: NormalizedKillmail) => {
      if (!listener) throw new Error('nobody subscribed to the feed');
      listener({ sequenceId: killmail.killmailId, killmail });
    },
    reset: () => {
      listener = null;
      unsubscribe.mockClear();
      subscribe.mockClear();
    },
  };
});

const searchMock = vi.hoisted(() => vi.fn());
const feedStatus = vi.hoisted(() => ({
  value: { running: false, lastPollAt: null, lastSuccessAt: null, lastError: null } as {
    running: boolean; lastPollAt: string | null; lastSuccessAt: string | null; lastError: string | null;
  },
}));

vi.mock('../../src/eve-kill/feed-poll.js', () => ({
  subscribeEveKillFeed: feedMocks.subscribe,
  getEveKillFeedRuntimeStatus: () => feedStatus.value,
}));
vi.mock('../../src/eve-kill/client.js', () => ({
  searchKillmails: searchMock,
}));

const {
  backfillSystems,
  getAttackerActivity,
  getKillFeedFreshness,
  getRecentKills,
  getRecentKillsForSystems,
  getSystemKillRollups,
  onIndexedKill,
  recordKillmail,
  resetMapKillIndexForTests,
  startMapKillIndex,
  sweepKillIndex,
} = await import('../../src/eve-map/kill-index.js');

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

function killmail(overrides: Partial<NormalizedKillmail> & { killmailId: number }): NormalizedKillmail {
  return {
    killmailHash: undefined,
    killmailTime: new Date(NOW - 60_000).toISOString(),
    solarSystemId: 30000142,
    regionId: 10000002,
    totalValue: 10_000_000,
    attackerCount: 1,
    isNpc: false,
    isSolo: true,
    victim: { characterId: 1, characterName: 'Victim', shipTypeId: 670, shipName: 'Capsule', shipGroupName: 'Capsule' },
    attackers: [{ characterId: 2, characterName: 'Hunter', shipTypeId: 11567, shipName: 'Avatar', finalBlow: true }],
    items: [],
    siblings: [],
    sourceShape: 'feed',
    ...overrides,
  } as NormalizedKillmail;
}

describe('map kill index', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    feedMocks.reset();
    searchMock.mockReset();
    resetMapKillIndexForTests();
  });

  afterEach(() => {
    resetMapKillIndexForTests();
    db.close();
  });

  it('writes one row per killmail and ignores redelivery', () => {
    const first = recordKillmail(db, killmail({ killmailId: 1 }), 'feed', NOW);
    const second = recordKillmail(db, killmail({ killmailId: 1 }), 'feed', NOW);

    expect(first).not.toBeNull();
    // Фид доставляет минимум однажды и может повторить после рестарта.
    expect(second).toBeNull();
    const rows = db.prepare('SELECT COUNT(*) AS n FROM map_kill_events').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('rejects a killmail without a usable system', () => {
    expect(recordKillmail(db, killmail({ killmailId: 2, solarSystemId: undefined }), 'feed', NOW)).toBeNull();
  });

  it('refuses undated backfill rows but accepts undated live ones', () => {
    // Бэкфилл без времени невозможно разложить по окнам, а «сейчас» сделало бы
    // старое событие свежим.
    expect(recordKillmail(db, killmail({ killmailId: 3, killmailTime: undefined }), 'backfill', NOW)).toBeNull();
    expect(recordKillmail(db, killmail({ killmailId: 4, killmailTime: undefined }), 'feed', NOW)).not.toBeNull();
  });

  it('notifies listeners for live events only', () => {
    const seen: number[] = [];
    const off = onIndexedKill((kill) => seen.push(kill.killmailId));

    recordKillmail(db, killmail({ killmailId: 10 }), 'feed', NOW);
    recordKillmail(db, killmail({ killmailId: 11 }), 'backfill', NOW);
    off();
    recordKillmail(db, killmail({ killmailId: 12 }), 'feed', NOW);

    expect(seen).toEqual([10]);
  });

  it('ingests from the feed subscription', () => {
    startMapKillIndex(db);
    feedMocks.emit(killmail({ killmailId: 20 }));

    const rows = db.prepare('SELECT killmail_id FROM map_kill_events').all() as Array<{ killmail_id: number }>;
    expect(rows).toEqual([{ killmail_id: 20 }]);
  });

  it('reports the kill layer honestly: live, stale, or not running', () => {
    // Раньше слой убийств всегда был «live»: мёртвая лента выглядела как
    // спокойный периметр — худшее, что может соврать радар.
    feedStatus.value = { running: true, lastPollAt: null, lastSuccessAt: null, lastError: null };
    expect(getKillFeedFreshness(NOW).status).toBe('unavailable');

    startMapKillIndex(db);
    feedStatus.value = {
      running: true,
      lastPollAt: new Date(NOW).toISOString(),
      lastSuccessAt: new Date(NOW - 5_000).toISOString(),
      lastError: null,
    };
    expect(getKillFeedFreshness(NOW)).toMatchObject({ status: 'live', error: null });

    feedStatus.value = { ...feedStatus.value, lastSuccessAt: new Date(NOW - 120_000).toISOString(), lastError: 'HTTP 503' };
    const stale = getKillFeedFreshness(NOW);
    expect(stale.status).toBe('cached');
    expect(stale.error).toContain('HTTP 503');

    feedStatus.value = { ...feedStatus.value, running: false };
    expect(getKillFeedFreshness(NOW).status).toBe('unavailable');
    feedStatus.value = { running: false, lastPollAt: null, lastSuccessAt: null, lastError: null };
  });

  it('subscribes only once even if started twice', () => {
    startMapKillIndex(db);
    startMapKillIndex(db);
    expect(feedMocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it('rolls up windows per system and keeps quiet systems in the result', () => {
    recordKillmail(db, killmail({ killmailId: 30, killmailTime: new Date(NOW - 5 * 60_000).toISOString() }), 'feed', NOW);
    recordKillmail(db, killmail({ killmailId: 31, killmailTime: new Date(NOW - 40 * 60_000).toISOString() }), 'feed', NOW);
    recordKillmail(db, killmail({ killmailId: 32, killmailTime: new Date(NOW - 5 * 60 * 60_000).toISOString() }), 'feed', NOW);
    recordKillmail(db, killmail({ killmailId: 33, isNpc: true, killmailTime: new Date(NOW - 60_000).toISOString() }), 'feed', NOW);

    const rollups = getSystemKillRollups(db, [30000142, 30000144], NOW);
    const jita = rollups.get(30000142)!;

    expect(jita.kills15m).toBe(2);
    expect(jita.kills1h).toBe(3);
    expect(jita.kills24h).toBe(4);
    expect(jita.pvpKills1h).toBe(2);
    expect(jita.npcKills1h).toBe(1);
    // Нулевые строки нужны карте не меньше, чем ненулевые.
    expect(rollups.get(30000144)!.kills1h).toBe(0);
    expect(rollups.get(30000144)!.lastKillMinutesAgo).toBeNull();
  });

  it('sweeps rows past the retention window', () => {
    recordKillmail(db, killmail({ killmailId: 40, killmailTime: new Date(NOW - 10 * 60 * 60_000).toISOString() }), 'feed', NOW);
    recordKillmail(db, killmail({ killmailId: 41 }), 'feed', NOW);

    const swept = sweepKillIndex(db, NOW);
    expect(swept.byAge).toBe(1);
    const rows = db.prepare('SELECT killmail_id FROM map_kill_events').all() as Array<{ killmail_id: number }>;
    expect(rows).toEqual([{ killmail_id: 41 }]);
  });

  it('returns recent kills newest first across systems', () => {
    recordKillmail(db, killmail({ killmailId: 50, killmailTime: new Date(NOW - 30 * 60_000).toISOString() }), 'feed', NOW);
    recordKillmail(db, killmail({
      killmailId: 51,
      solarSystemId: 30000144,
      killmailTime: new Date(NOW - 60_000).toISOString(),
    }), 'feed', NOW);

    const kills = getRecentKillsForSystems(db, [30000142, 30000144], { limit: 10 });
    expect(kills.map((kill) => kill.killmailId)).toEqual([51, 50]);
    expect(getRecentKills(db, 30000142).map((kill) => kill.killmailId)).toEqual([50]);
  });

  it('counts attacker activity per system for repeat detection', () => {
    recordKillmail(db, killmail({ killmailId: 60 }), 'feed', NOW);
    recordKillmail(db, killmail({ killmailId: 61 }), 'feed', NOW);
    recordKillmail(db, killmail({
      killmailId: 62,
      attackers: [{ characterId: 9, characterName: 'Other', finalBlow: true }],
    }), 'feed', NOW);

    const activity = getAttackerActivity(db, [30000142], NOW - 60 * 60_000);
    const hunters = activity.get(30000142)!;
    expect(hunters.find((entry) => entry.characterId === 2)?.kills).toBe(2);
    expect(hunters.find((entry) => entry.characterId === 9)?.kills).toBe(1);
  });

  describe('backfill', () => {
    it('pulls history once per system inside the TTL', async () => {
      searchMock.mockResolvedValue({
        ok: true,
        data: { kills: [killmail({ killmailId: 70 })], truncated: false, requestCount: 1, windows: [] },
      });

      const first = await backfillSystems(db, [30000142], NOW);
      const second = await backfillSystems(db, [30000142], NOW);

      expect(first.requested).toBe(1);
      expect(first.ingested).toBe(1);
      // Второй зритель того же пузыря не платит за повторный веер запросов.
      expect(second.requested).toBe(0);
      expect(searchMock).toHaveBeenCalledTimes(1);
    });

    it('marks systems even when the upstream request fails', async () => {
      searchMock.mockResolvedValue({ ok: false, error: 'upstream down' });

      const result = await backfillSystems(db, [30000142], NOW);
      expect(result.error).toBe('upstream down');
      // Иначе падающий провайдер превращается в шторм повторов.
      const marked = db.prepare('SELECT COUNT(*) AS n FROM map_kill_backfill').get() as { n: number };
      expect(marked.n).toBe(1);
    });

    it('does not flash backfilled history on live listeners', async () => {
      const seen: number[] = [];
      onIndexedKill((kill) => seen.push(kill.killmailId));
      searchMock.mockResolvedValue({
        ok: true,
        data: { kills: [killmail({ killmailId: 80 })], truncated: false, requestCount: 1, windows: [] },
      });

      await backfillSystems(db, [30000142], NOW);
      expect(seen).toEqual([]);
    });
  });
});
