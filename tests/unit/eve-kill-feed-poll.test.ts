import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  runFeedPollOnce,
  startEveKillFeedPoller,
  stopEveKillFeedPoller,
  subscribeEveKillFeed,
} from '../../src/eve-kill/feed-poll.js';
import { OutboundDeliveryError } from '../../src/messaging/outbound.js';

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;
let unsubscribe: Array<() => void>;
let tempDirs: string[];

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  unsubscribe = [];
  tempDirs = [];
});

afterEach(async () => {
  await stopEveKillFeedPoller();
  for (const stop of unsubscribe) stop();
  vi.unstubAllGlobals();
  db.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('durable EVE-KILL feed poller', () => {
  it('bootstraps to the current head without replaying history', async () => {
    respondWith({ data: [], latest: 55, hasMore: true, next: '/feed/poll?after=55', last: null });
    const send = vi.fn(async () => {});

    const result = await runFeedPollOnce(db, send);

    expect(result).toEqual({
      ok: true,
      data: { bootstrapped: true, processed: 0, delivered: 0, cursor: 55, hasMore: false },
    });
    expect(send).not.toHaveBeenCalled();
    expect(feedCursor()).toBe(55);
    expect(requestUrl()).toContain('/feed/poll?after=0&limit=100');
  });

  it('matches system, SDE-derived region, victim, and attacker topics', async () => {
    seedCursor(10);
    db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)')
      .run(200, 'Constellation', 400, '{}');
    db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)')
      .run(300, 'System', 200, '{}');
    addWatch(1, 'system.300');
    addWatch(2, 'region.400');
    addWatch(3, 'victim.11');
    addWatch(4, 'attacker.22');
    respondWith(feedPage(11, 9001));
    const listener = vi.fn(async () => {});
    unsubscribe.push(subscribeEveKillFeed(listener));
    const send = vi.fn(async () => {});

    const result = await runFeedPollOnce(db, send);

    expect(result.ok && result.data).toMatchObject({ processed: 1, delivered: 4, cursor: 11 });
    expect(listener).toHaveBeenCalledOnce();
    expect(send.mock.calls.map((call) => call[0]).sort()).toEqual([1, 2, 3, 4]);
    expect(send.mock.calls[0]![1]).toContain('https://eve-kill.com/kill/9001');
    expect(feedCursor()).toBe(11);
    expect(dedupCount()).toBe(4);
  });

  it('persists per-chat dedup and retries only a failed recipient before advancing', async () => {
    seedCursor(20);
    addWatch(1, 'system.300');
    addWatch(2, 'victim.11');
    respondWith(feedPage(21, 9002));
    const firstSend = vi.fn(async (chatId: number) => {
      if (chatId === 2) throw new Error('platform unavailable');
    });

    const first = await runFeedPollOnce(db, firstSend);

    expect(first).toEqual({
      ok: false,
      error: 'EVE-KILL feed processing failed at sequence 21',
    });
    expect(feedCursor()).toBe(20);
    expect(dedupCount()).toBe(1);

    respondWith(feedPage(21, 9002));
    const retrySend = vi.fn(async () => {});
    const retry = await runFeedPollOnce(db, retrySend);

    expect(retry.ok && retry.data).toMatchObject({ processed: 1, delivered: 1, cursor: 21 });
    expect(retrySend).toHaveBeenCalledOnce();
    expect(retrySend.mock.calls[0]![0]).toBe(2);
    expect(dedupCount()).toBe(2);
  });

  it('acknowledges a permanently unreachable recipient without blocking other watches', async () => {
    seedCursor(20);
    addWatch(1, 'system.300');
    addWatch(2, 'system.300');
    respondWith(feedPage(21, 9_021));
    const send = vi.fn(async (chatId: number) => {
      if (chatId === 1) throw new OutboundDeliveryError('bot was blocked', true);
    });

    const result = await runFeedPollOnce(db, send);

    expect(result.ok && result.data).toMatchObject({ processed: 1, delivered: 1, cursor: 21 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(feedCursor()).toBe(21);
    expect(dedupCount()).toBe(2);
  });

  it('does not let a terminal listener delivery failure freeze the shared cursor', async () => {
    seedCursor(30);
    respondWith(feedPage(31, 9_031));
    const nextListener = vi.fn(async () => {});
    unsubscribe.push(subscribeEveKillFeed(async () => {
      throw new OutboundDeliveryError('Discord recipient is gone', true);
    }));
    unsubscribe.push(subscribeEveKillFeed(nextListener));

    const result = await runFeedPollOnce(db, async () => {});

    expect(result.ok && result.data).toMatchObject({ processed: 1, cursor: 31 });
    expect(nextListener).toHaveBeenCalledOnce();
    expect(feedCursor()).toBe(31);
  });

  it('suspends an unavailable platform watch without poisoning active consumers', async () => {
    seedCursor(21);
    addWatch(1, 'system.300');
    addWatch(-2, 'system.300');
    respondWith(feedPage(22, 9022));
    const listener = vi.fn(async () => {});
    unsubscribe.push(subscribeEveKillFeed(listener));
    const send = vi.fn(async () => {});

    const result = await runFeedPollOnce(db, send, {
      canDeliver: (chatId) => chatId < 0,
    });

    expect(result.ok && result.data).toMatchObject({ processed: 1, delivered: 1, cursor: 22 });
    expect(listener).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(-2, expect.any(String));
    expect(feedCursor()).toBe(22);
    expect(dedupCount()).toBe(1);
  });

  it('does not advance the durable cursor while an awaited listener owns the event', async () => {
    seedCursor(21);
    respondWith(feedPage(22, 9022));
    let releaseListener = (): void => {};
    const listenerBarrier = new Promise<void>((resolve) => { releaseListener = resolve; });
    let listenerStarted = false;
    unsubscribe.push(subscribeEveKillFeed(async () => {
      listenerStarted = true;
      await listenerBarrier;
    }));

    const pendingPoll = runFeedPollOnce(db, async () => {});
    await vi.waitFor(() => expect(listenerStarted).toBe(true));

    expect(feedCursor()).toBe(21);
    releaseListener();
    await expect(pendingPoll).resolves.toMatchObject({
      ok: true,
      data: { processed: 1, cursor: 22 },
    });
    expect(feedCursor()).toBe(22);
  });

  it('preserves cursor and recipient dedup across a SQLite restart', async () => {
    db.close();
    const dir = mkdtempSync(join(tmpdir(), 'eve-kill-feed-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'feed.sqlite');
    db = new Database(dbPath);
    db.exec(SCHEMA_SQL);
    seedCursor(22);
    addWatch(1, 'system.300');
    addWatch(2, 'victim.11');
    respondWith(feedPage(23, 9023));

    const first = await runFeedPollOnce(db, async (chatId) => {
      if (chatId === 2) throw new Error('platform unavailable');
    });
    expect(first.ok).toBe(false);
    expect(feedCursor()).toBe(22);
    expect(dedupCount()).toBe(1);

    db.close();
    db = new Database(dbPath);
    respondWith(feedPage(23, 9023));
    const retrySend = vi.fn(async () => {});

    const retry = await runFeedPollOnce(db, retrySend);

    expect(retry.ok && retry.data).toMatchObject({ delivered: 1, cursor: 23 });
    expect(retrySend).toHaveBeenCalledOnce();
    expect(retrySend.mock.calls[0]![0]).toBe(2);
    expect(dedupCount()).toBe(2);
  });

  it('derives region watches from local SDE and ignores a conflicting third-party region', async () => {
    seedCursor(25);
    db.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (?, ?, ?, ?)')
      .run(200, 'Constellation', 400, '{}');
    db.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, ?, ?)')
      .run(300, 'System', 200, '{}');
    addWatch(1, 'region.400');
    addWatch(2, 'region.999');
    const payload = feedPage(26, 9026);
    const event = (payload.data as Array<{ data: Record<string, unknown> }>)[0]!;
    event.data.region_id = 999;
    respondWith(payload);
    const send = vi.fn(async () => {});

    const result = await runFeedPollOnce(db, send);

    expect(result.ok && result.data).toMatchObject({ processed: 1, delivered: 1, cursor: 26 });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toBe(1);
    expect(feedCursor()).toBe(26);
  });

  it('awaits clean shutdown while the poller is waiting', async () => {
    respondWith({ data: [], latest: 88, hasMore: true, next: null, last: null });
    startEveKillFeedPoller(db, async () => {}, { pollIntervalMs: 60_000 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    await expect(stopEveKillFeedPoller()).resolves.toBeUndefined();
    expect(feedCursor()).toBe(88);
  });

  it('bootstraps first and restores listeners before processing the first live event', async () => {
    respondWith({ data: [], latest: 90, hasMore: false, next: null, last: null });
    respondWith(feedPage(91, 9091));
    const listener = vi.fn(async () => {});
    const onReady = vi.fn(() => {
      unsubscribe.push(subscribeEveKillFeed(listener));
    });

    startEveKillFeedPoller(db, async () => {}, { pollIntervalMs: 1, onReady });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    await stopEveKillFeedPoller();

    expect(onReady).toHaveBeenCalledOnce();
    expect(feedCursor()).toBe(91);
    expect(requestUrl()).toContain('/feed/poll?after=0&limit=100');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/feed/poll?after=90&limit=100');
  });

  it('rejects an oversized upstream page without sending or advancing', async () => {
    seedCursor(30);
    addWatch(1, 'system.300');
    const first = feedPage(31, 9031);
    const secondEvent = (feedPage(32, 9032).data as unknown[])[0];
    (first.data as unknown[]).push(secondEvent);
    first.latest = 32;
    respondWith(first);
    const send = vi.fn(async () => {});

    const result = await runFeedPollOnce(db, send, { limit: 1 });

    expect(result).toEqual({ ok: false, error: 'EVE-KILL invalid response: feed page exceeded requested limit' });
    expect(send).not.toHaveBeenCalled();
    expect(feedCursor()).toBe(30);
  });

  it('backs off instead of hot-looping when hasMore makes no cursor progress', async () => {
    seedCursor(35);
    respondWith(feedPage(35, 9035, true));

    const result = await runFeedPollOnce(db, async () => {});

    expect(result).toEqual({ ok: false, error: 'EVE-KILL feed returned hasMore without a newer event' });
    expect(feedCursor()).toBe(35);
  });

  it('prunes stale notification dedup on an initialized long-lived database', async () => {
    seedCursor(40);
    db.prepare(`
      INSERT INTO eve_kill_notification_dedup (chat_id, killmail_id, sequence_id, delivered_at)
      VALUES (1, 1, 1, datetime('now', '-31 days')), (1, 2, 2, datetime('now'))
    `).run();
    respondWith({ data: [], latest: 40, hasMore: false, next: null, last: null });

    const result = await runFeedPollOnce(db, async () => {});

    expect(result.ok).toBe(true);
    expect(dedupCount()).toBe(1);
    const state = db.prepare(
      "SELECT dedup_pruned_at FROM eve_kill_feed_state WHERE feed_key = 'global'",
    ).get() as { dedup_pruned_at: string | null };
    expect(state.dedup_pruned_at).not.toBeNull();
  });
});

function respondWith(payload: unknown): void {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function feedPage(sequenceId: number, killmailId: number, hasMore = false): Record<string, unknown> {
  const data = {
    killmail_id: killmailId,
    killmail_hash: `hash-${killmailId}`,
    killmail_time: '2026-07-13T12:00:00Z',
    solar_system_id: 300,
    victim: {
      character_id: 11,
      corporation_id: 12,
      ship_type_id: 13,
      damage_taken: 100,
      position: { x: 1, y: 2, z: 3 },
    },
    attackers: [{ character_id: 22, corporation_id: 23, damage_done: 100, final_blow: true }],
  };
  return {
    data: [{ seq: sequenceId, killmail_id: killmailId, killmail_hash: `hash-${killmailId}`, data }],
    latest: sequenceId,
    hasMore,
    next: null,
    last: null,
  };
}

function seedCursor(sequenceId: number): void {
  db.prepare('INSERT INTO eve_kill_feed_state (feed_key, last_sequence_id) VALUES (?, ?)')
    .run('global', sequenceId);
}

function addWatch(chatId: number, topic: string): void {
  db.prepare('INSERT INTO kill_watches (chat_id, topic, label) VALUES (?, ?, ?)')
    .run(chatId, topic, topic);
}

function feedCursor(): number | undefined {
  return (db.prepare(
    "SELECT last_sequence_id FROM eve_kill_feed_state WHERE feed_key = 'global'",
  ).get() as { last_sequence_id: number } | undefined)?.last_sequence_id;
}

function dedupCount(): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM eve_kill_notification_dedup').get() as { count: number }).count;
}

function requestUrl(): string {
  return String(fetchMock.mock.calls[0]![0]);
}
