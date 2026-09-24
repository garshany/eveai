import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  getEveKillFeedRuntimeStatus,
  resetEveKillFeedObserversForTests,
  runFeedPollOnce,
  subscribeEveKillFeed,
} from '../../src/eve-kill/feed-poll.js';
import { resetMapKillIndexForTests, startMapKillIndex } from '../../src/eve-map/kill-index.js';

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  resetEveKillFeedObserversForTests();
  resetMapKillIndexForTests();
});

afterEach(() => {
  resetMapKillIndexForTests();
  resetEveKillFeedObserversForTests();
  vi.unstubAllGlobals();
  db.close();
});

describe('non-blocking feed observers (map kill index)', () => {
  it('keeps the map index flowing while watch delivery holds the durable cursor', async () => {
    seedCursor(20);
    addWatch(1, 'system.300');
    startMapKillIndex(db);
    let platformDown = true;
    const send = vi.fn(async () => {
      if (platformDown) throw new Error('telegram unavailable');
    });

    // Poll 1: the held page (21) plus a look-ahead page (22) reach the index.
    respondWith(page([[21, 9021]], true));
    respondWith(page([[22, 9022]], false));
    const first = await runFeedPollOnce(db, send, { limit: 1 });
    expect(first.ok).toBe(false);
    expect(feedCursor()).toBe(20);
    expect(indexedIds()).toEqual([9021, 9022]);

    // Poll 2: still down; a kill that arrived meanwhile (23) is still indexed.
    respondWith(page([[21, 9021]], true));
    respondWith(page([[23, 9023]], false));
    const second = await runFeedPollOnce(db, send, { limit: 1 });
    expect(second.ok).toBe(false);
    expect(feedCursor()).toBe(20);
    expect(indexedIds()).toEqual([9021, 9022, 9023]);
    expect(getEveKillFeedRuntimeStatus().lastObservedAt).not.toBeNull();

    // Recovery: the durable cursor replays every missed kill to the watch.
    platformDown = false;
    send.mockClear();
    for (const [seq, id, more] of [[21, 9021, true], [22, 9022, true], [23, 9023, false]] as const) {
      respondWith(page([[seq, id]], more));
      const result = await runFeedPollOnce(db, send, { limit: 1 });
      expect(result.ok).toBe(true);
    }
    expect(feedCursor()).toBe(23);
    expect(send.mock.calls.map((call) => (call as unknown[])[1] as string)
      .map((text) => Number(/kill\/(\d+)/.exec(text)?.[1])))
      .toEqual([9021, 9022, 9023]);
    expect(indexedIds()).toEqual([9021, 9022, 9023]);
  });

  it('never lets a throwing observer hold the cursor', async () => {
    seedCursor(30);
    const stop = subscribeEveKillFeed(() => { throw new Error('observer broke'); }, { mode: 'observer' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      respondWith(page([[31, 9031]], false));
      const result = await runFeedPollOnce(db, vi.fn(async () => {}));
      expect(result.ok && result.data.cursor).toBe(31);
    } finally {
      stop();
      warn.mockRestore();
    }
  });
});

function respondWith(payload: unknown): void {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function page(events: Array<[number, number]>, hasMore: boolean): Record<string, unknown> {
  const data = events.map(([seq, killmailId]) => ({
    seq,
    killmail_id: killmailId,
    killmail_hash: `hash-${killmailId}`,
    data: {
      killmail_id: killmailId,
      killmail_hash: `hash-${killmailId}`,
      killmail_time: new Date().toISOString(),
      solar_system_id: 300,
      victim: { character_id: 11, corporation_id: 12, ship_type_id: 13, damage_taken: 100 },
      attackers: [{ character_id: 22, corporation_id: 23, damage_done: 100, final_blow: true }],
    },
  }));
  return { data, latest: 99, hasMore, next: null, last: null };
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
  return (db.prepare('SELECT last_sequence_id FROM eve_kill_feed_state WHERE feed_key = ?')
    .get('global') as { last_sequence_id: number } | undefined)?.last_sequence_id;
}

function indexedIds(): number[] {
  return (db.prepare('SELECT killmail_id FROM map_kill_events ORDER BY killmail_id').all() as Array<{ killmail_id: number }>)
    .map((row) => row.killmail_id);
}
