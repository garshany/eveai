/**
 * «Периметр» end to end: the real `/api/web/map/live` SSE route on a real
 * Fastify server, read over a real HTTP socket, fed by the real EVE-KILL feed
 * poller → kill index → onIndexedKill path, with only the network edges
 * scripted (ESI, the EVE-KILL feed page, EVE-Scout, backfill search).
 *
 * The question this answers is not "does a function return the right value"
 * but "does the radar behave like a radar": it follows the pilot, reacts to a
 * kill within seconds, stays quiet about kills elsewhere, does not repeat
 * itself, survives an ESI wobble, stops cleanly, and leaves nothing running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const env = vi.hoisted(() => {
  process.env.MAP_LIVE_SESSION_MAX_FAILURES = '3';
  process.env.MAP_INTEL_REFRESH_SECONDS = '15';
  process.env.MAP_LOCATION_POLL_SECONDS = '5';
  process.env.MAP_ADVISOR_COOLDOWN_SECONDS = '60';
  return {};
});
void env;

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const script = vi.hoisted(() => ({
  systemId: 0,
  online: true,
  esiFail: null as string | null,
  /** When set, the hourly-baseline call (first network step of a bubble build) waits on it. */
  buildGate: null as Promise<void> | null,
  locationCalls: 0,
  feedEvents: [] as Array<{ sequenceId: number; killmail: unknown }>,
  feedFail: null as string | null,
}));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: vi.fn(async (_db: unknown, operation: string, args: Record<string, unknown>) => {
    if (operation.startsWith('get_characters_character_id_')) {
      if (operation === 'get_characters_character_id_location') script.locationCalls += 1;
      if (script.esiFail) return { ok: false, status: 502, error: script.esiFail };
      if (operation === 'get_characters_character_id_online') {
        return { ok: true, status: 200, data: { online: script.online } };
      }
      if (operation === 'get_characters_character_id_location') {
        return { ok: true, status: 200, data: { solar_system_id: script.systemId } };
      }
      return { ok: true, status: 200, data: { ship_type_id: 587, ship_name: 'Rifter' } };
    }
    if (operation === 'get_universe_system_kills') {
      if (script.buildGate) await script.buildGate;
      return { ok: true, status: 200, data: [] };
    }
    if (operation === 'get_universe_system_jumps' || operation === 'get_sovereignty_map') {
      return { ok: true, status: 200, data: [] };
    }
    if (operation === 'post_universe_names') {
      const ids = JSON.parse(String(args.ids)) as number[];
      return { ok: true, status: 200, data: ids.map((id) => ({ id, name: `Pilot ${id}`, category: 'character' })) };
    }
    return { ok: false, status: 404, error: `unscripted ${operation}` };
  }),
}));
// The radar's model assessment: scripted, and counted, so the cooldown and the
// billing can be asserted without a network.
const modelCalls = vi.hoisted(() => ({ count: 0, facts: [] as string[] }));
vi.mock('../../src/agent/native-responses.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/native-responses.js')>();
  return {
    ...actual,
    createNativeResponse: vi.fn(async (input: { items: Array<{ content: Array<{ text: string }> }> }) => {
      modelCalls.count += 1;
      modelCalls.facts.push(input.items[0]!.content[0]!.text);
      return {
        id: 'resp_radar', output: [], outputText: 'Тебя ведут от B: тот же пилот убивает по твоему следу. Не стой — уходи в док в C.',
        error: null, status: 'completed', toolSearchPaths: [], rawEvents: [],
        usage: { input: 900, output: 40, cached: 0, reasoning: 10 },
      };
    }),
  };
});
vi.mock('../../src/eve/capabilities.js', () => ({
  getEveCapabilities: vi.fn(async () => ({ linked: true })),
  hasFreshCapabilitySnapshot: vi.fn(() => true),
}));
vi.mock('../../src/eve/eve-scout-client.js', () => ({
  getSignatures: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('../../src/eve-kill/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/eve-kill/client.js')>();
  return {
    ...actual,
    fetchFeedPage: vi.fn(async (after: number, limit = 100) => {
      if (script.feedFail) return { ok: false, error: script.feedFail };
      const events = script.feedEvents.filter((event) => event.sequenceId > after).slice(0, limit);
      const latest = Math.max(100, ...script.feedEvents.map((event) => event.sequenceId));
      return { ok: true, data: { events, latest, hasMore: false, next: null, last: null } };
    }),
    searchKillmails: vi.fn(async () => ({
      ok: true,
      data: { kills: [], truncated: false, requestCount: 0, windows: [] },
    })),
  };
});

const Fastify = (await import('fastify')).default;
const fastifyCookie = (await import('@fastify/cookie')).default;
const Database = (await import('better-sqlite3')).default;
const { SCHEMA_SQL } = await import('../../src/db/schema.js');
const { runMigrations } = await import('../../src/db/migrations.js');
const { registerMapRoutes } = await import('../../src/web/map-routes.js');
const { createWebSession, resetWebSessionCreationGuardForTests, WEB_SESSION_COOKIE } = await import(
  '../../src/web/web-session.js'
);
const { buildMapGraph, invalidateMapGraphCache } = await import('../../src/eve/map-graph.js');
const { getLiveSessionStats, resetLiveSessionsForTests } = await import('../../src/eve-map/live-session.js');
const { resetSharedAdvisorStatesForTests, sharedAdvisorRefsForTests } = await import('../../src/eve-map/advisor.js');
const { resetMapKillIndexForTests, startMapKillIndex } = await import('../../src/eve-map/kill-index.js');
const { startEveKillFeedPoller, stopEveKillFeedPoller } = await import('../../src/eve-kill/feed-poll.js');
const { readPerimeterHistory } = await import('../../src/eve-map/thread.js');
const { resetActiveRoutesForTests } = await import('../../src/eve-map/active-route.js');
const { resetNameCacheForTests } = await import('../../src/eve-map/names.js');

// A chain A–B–C–D–E–F–G–H plus a far system Z hanging off H. Radius 1 keeps
// every bubble to three systems, so "in" and "out" are unambiguous.
const A = 30000001;
const B = 30000002;
const C = 30000003;
const D = 30000004;
const Z = 30000099;
const CHAIN = [A, B, C, D, 30000005, 30000006, 30000007, 30000008, Z];
const CHARACTER_ID = 90000001;
const NOW = Date.parse('2026-09-24T12:00:00Z');

type Frame = { id: number | null; event: string; data: Record<string, unknown> };
type Client = { frames: Frame[]; ended: boolean; close: () => void };

let db: InstanceType<typeof Database>;
let app: ReturnType<typeof Fastify>;
let port: number;
let cookie: string;
let csrfToken: string;
const ORIGIN = 'http://localhost:3000';
let threadIdSeen: string | null = null;
let sequence = 100;
let killmailId = 5000;

function seedGraph(database: InstanceType<typeof Database>): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sde_meta (build_number TEXT, loaded_at TEXT);
    CREATE TABLE IF NOT EXISTS sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, constellation_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_constellations (constellation_id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_regions (region_id INTEGER PRIMARY KEY, name TEXT, data_json TEXT);
    CREATE TABLE IF NOT EXISTS sde_stargates (stargate_id INTEGER PRIMARY KEY, system_id INTEGER, destination_system_id INTEGER, destination_stargate_id INTEGER, data_json TEXT);
  `);
  database.prepare('INSERT INTO sde_meta (build_number, loaded_at) VALUES (?, ?)').run('1', 'now');
  database.prepare('INSERT INTO sde_regions (region_id, name, data_json) VALUES (1, ?, ?)').run('R', '{}');
  database.prepare('INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (1, ?, 1, ?)')
    .run('C', '{}');
  const system = database.prepare('INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (?, ?, 1, ?)');
  CHAIN.forEach((id, index) => {
    system.run(id, `Sys${index}`, JSON.stringify({ securityStatus: 0.9, position2D: { x: index * 10, y: 0 } }));
  });
  const gate = database.prepare(
    'INSERT INTO sde_stargates (stargate_id, system_id, destination_system_id, destination_stargate_id, data_json) VALUES (?, ?, ?, NULL, ?)',
  );
  let gateId = 1;
  for (let index = 0; index < CHAIN.length - 1; index += 1) {
    gate.run(gateId++, CHAIN[index], CHAIN[index + 1], '{}');
    gate.run(gateId++, CHAIN[index + 1], CHAIN[index], '{}');
  }
  buildMapGraph(database, { force: true });
}

function linkCharacter(session: { userId: number; chatId: number }): void {
  db.prepare(`
    INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, 'Radar Pilot', JSON.stringify(['esi-location.read_location.v1']), session.userId);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(session.chatId, CHARACTER_ID, session.userId);
  db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(CHARACTER_ID, session.userId);
}

/** A real HTTP client that parses SSE frames off the socket as they arrive. */
function openLive(query = '?radius=1'): Promise<Client> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const client: Client = { frames, ended: false, close: () => undefined };
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: `/api/web/map/live${query}`,
      headers: { cookie, accept: 'text/event-stream' },
    }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`live stream answered ${response.statusCode}`));
        return;
      }
      expect(response.headers['content-type']).toContain('text/event-stream');
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let split = buffer.indexOf('\n\n');
        while (split >= 0) {
          const raw = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf('\n\n');
          if (raw.startsWith(':')) {
            frames.push({ id: null, event: 'comment', data: {} });
            continue;
          }
          const lines = raw.split('\n');
          const id = lines.find((line) => line.startsWith('id: '))?.slice(4);
          const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message';
          const data = lines.find((line) => line.startsWith('data: '))?.slice(6) ?? '{}';
          frames.push({ id: id ? Number(id) : null, event, data: JSON.parse(data) as Record<string, unknown> });
        }
      });
      response.on('end', () => { client.ended = true; });
      response.on('close', () => { client.ended = true; });
      client.close = () => { request.destroy(); };
      resolve(client);
    });
    request.on('error', (error) => {
      if (!client.ended) reject(error);
    });
  });
}

/** Lets real I/O (socket reads/writes) run between fake-timer steps. */
async function flushIo(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function until(condition: () => boolean, label: string, rounds = 400): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Advance fake time in small steps so real I/O keeps up with timer callbacks. */
async function advance(ms: number, step = 250): Promise<void> {
  let left = ms;
  while (left > 0) {
    const slice = Math.min(step, left);
    await vi.advanceTimersByTimeAsync(slice);
    await flushIo(4);
    left -= slice;
  }
}

function of(client: Client, event: string): Frame[] {
  return client.frames.filter((frame) => frame.event === event);
}

function indexOf(client: Client, predicate: (frame: Frame) => boolean): number {
  return client.frames.findIndex(predicate);
}

function rules(client: Client, rule: string): Frame[] {
  return of(client, 'advisory').filter((frame) => (frame.data.advisory as { rule: string }).rule === rule);
}

function bubbleOrigin(frame: Frame): number {
  return (frame.data.bubble as { originId: number }).originId;
}

/** Publish one killmail on the scripted EVE-KILL feed; the real poller picks it up. */
async function feedKill(systemId: number, options: { value?: number; attacker?: number } = {}): Promise<number> {
  sequence += 1;
  killmailId += 1;
  const id = killmailId;
  script.feedEvents.push({
    sequenceId: sequence,
    killmail: {
      killmailId: id,
      killmailHash: `hash-${id}`,
      killmailTime: new Date(Date.now()).toISOString(),
      solarSystemId: systemId,
      totalValue: options.value ?? 10_000_000,
      attackerCount: 1,
      isNpc: false,
      isSolo: true,
      victim: { characterId: 1000 + id, shipTypeId: 587, shipName: 'Rifter' },
      attackers: [{ characterId: options.attacker ?? 7000 + id, finalBlow: true, shipTypeId: 11198 }],
      items: [],
      siblings: [],
      sourceShape: 'feed',
    },
  });
  // Feed poll interval is 250 ms in this harness.
  await until(() => {
    const row = db.prepare('SELECT 1 FROM map_kill_events WHERE killmail_id = ?').get(id);
    return row !== undefined;
  }, `killmail ${id} indexed`, 50).catch(async () => {
    await advance(300, 100);
    await until(() => db.prepare('SELECT 1 FROM map_kill_events WHERE killmail_id = ?').get(id) !== undefined,
      `killmail ${id} indexed`);
  });
  await flushIo();
  return id;
}

function threadAdvisories(threadId: string): Array<{ rule: string; repeats: number }> {
  return readPerimeterHistory(db, threadId, 200)
    .filter((message) => message.meta?.kind === 'advisory')
    .map((message) => ({ rule: message.meta!.rule, repeats: message.meta!.repeats }));
}

beforeEach(async () => {
  vi.useFakeTimers({
    shouldAdvanceTime: false,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: NOW,
  });
  modelCalls.count = 0;
  modelCalls.facts = [];
  Object.assign(script, {
    systemId: A, online: true, esiFail: null, buildGate: null, locationCalls: 0, feedEvents: [], feedFail: null,
  });
  sequence = 100;
  killmailId = 5000;
  threadIdSeen = null;
  resetLiveSessionsForTests();
  resetSharedAdvisorStatesForTests();
  resetMapKillIndexForTests();
  resetActiveRoutesForTests();
  resetNameCacheForTests();
  resetWebSessionCreationGuardForTests();

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  seedGraph(db);
  const session = createWebSession(db);
  linkCharacter(session);
  cookie = `${WEB_SESSION_COOKIE}=${session.sessionToken}`;
  csrfToken = session.csrfToken;

  // Real feed poller, real kill index. Bootstrap sets the cursor to 100.
  startMapKillIndex(db);
  startEveKillFeedPoller(db, async () => {}, { pollIntervalMs: 250 });
  await advance(300, 100);

  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerMapRoutes(app, db, {} as never);
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  await stopEveKillFeedPoller();
  resetMapKillIndexForTests();
  resetLiveSessionsForTests();
  await app.close();
  vi.useRealTimers();
  db.close();
  invalidateMapGraphCache();
});

describe('Perimeter live radar, end to end over real SSE', () => {
  it('follows the pilot, reacts to kills promptly, survives ESI trouble and cleans up', async () => {
    const tab = await openLive();
    await until(() => of(tab, 'intel').length >= 1, 'first intel');

    // ready → route → location → intel, bubble centred on A.
    const ready = of(tab, 'ready')[0]!;
    threadIdSeen = ready.data.threadId as string;
    expect(ready.data).toMatchObject({ characterId: CHARACTER_ID, radius: 1, pollSeconds: 5 });
    const iRoute = indexOf(tab, (frame) => frame.event === 'route');
    const iReady = indexOf(tab, (frame) => frame.event === 'ready');
    const iLocation = indexOf(tab, (frame) => frame.event === 'location');
    const iIntel = indexOf(tab, (frame) => frame.event === 'intel');
    expect(iRoute).toBeLessThan(iLocation);
    expect(iReady).toBeLessThan(iLocation);
    expect(iLocation).toBeLessThan(iIntel);
    expect((of(tab, 'location')[0]!.data.location as { solarSystemId: number }).solarSystemId).toBe(A);
    expect(bubbleOrigin(of(tab, 'intel')[0]!)).toBe(A);
    // Monotonic ids for Last-Event-ID resume.
    const ids = tab.frames.filter((frame) => frame.id !== null).map((frame) => frame.id!);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    // The feed is up, so the kill layer says so.
    const killsLayer = (of(tab, 'intel')[0]!.data.bubble as { freshness: Array<{ layer: string; status: string }> })
      .freshness.find((layer) => layer.layer === 'kills');
    expect(killsLayer?.status).toBe('live');

    // Out-of-bubble kill: indexed, but the radar does not mention it.
    await feedKill(Z, { value: 5_000_000_000 });
    await advance(2_000);
    expect(of(tab, 'kill')).toHaveLength(0);
    expect(of(tab, 'advisory')).toHaveLength(0);

    // In-bubble kill: an immediate 'kill' frame, and the advisory follows
    // within the debounce — well before the 15 s intel tick.
    const intelBefore = of(tab, 'intel').length;
    const big = await feedKill(B, { value: 2_000_000_000 });
    await until(() => of(tab, 'kill').length === 1, 'kill frame');
    expect((of(tab, 'kill')[0]!.data.kill as { killmailId: number }).killmailId).toBe(big);
    await advance(2_000);
    expect(of(tab, 'intel').length).toBe(intelBefore + 1);
    // Hull 587 has no dogma rows in this SDE: unknown, not "survival: dead".
    expect(rules(tab, 'capability_gap')).toHaveLength(0);
    expect((of(tab, 'intel').at(-1)!.data.bubble as { pilotShip: unknown }).pilotShip).toBeNull();
    const spikes = rules(tab, 'value_spike');
    expect(spikes).toHaveLength(1);
    expect(spikes[0]!.data.advisory).toMatchObject({ killmailId: big, systemId: B, repeats: 0 });
    // Persisted into the Perimeter thread as well as streamed.
    const persisted = threadAdvisories(threadIdSeen);
    expect(persisted).toContainEqual({ rule: 'value_spike', repeats: 0 });
    expect(persisted).toHaveLength(of(tab, 'advisory').length);

    // A burst of two more in-bubble kills shares one rebuild; the second
    // expensive kill inside the cooldown collapses instead of repeating.
    await feedKill(A, { value: 3_000_000_000 });
    await feedKill(A);
    const intelBeforeBurst = of(tab, 'intel').length;
    await advance(2_000);
    expect(of(tab, 'kill')).toHaveLength(3);
    expect(of(tab, 'intel').length).toBe(intelBeforeBurst + 1);
    expect(rules(tab, 'value_spike')).toHaveLength(1);
    expect(threadAdvisories(threadIdSeen).filter((entry) => entry.rule === 'value_spike')).toHaveLength(1);

    // Jump A → B: a jumped location and an intel recentred on B; nothing
    // centred on A is published after the jump.
    script.systemId = B;
    await advance(5_000);
    await until(() => of(tab, 'intel').some((frame) => bubbleOrigin(frame) === B), 'intel on B');
    const jumpB = of(tab, 'location').find(
      (frame) => (frame.data.location as { solarSystemId: number }).solarSystemId === B,
    )!;
    expect(jumpB.data).toMatchObject({ jumped: true, previousSystemId: A });
    const afterJumpB = tab.frames.slice(tab.frames.indexOf(jumpB));
    expect(afterJumpB.filter((frame) => frame.event === 'intel').every((frame) => bubbleOrigin(frame) === B)).toBe(true);

    // Jump B → C.
    script.systemId = C;
    await advance(5_000);
    await until(() => of(tab, 'intel').some((frame) => bubbleOrigin(frame) === C), 'intel on C');
    const jumpC = of(tab, 'location').find(
      (frame) => (frame.data.location as { solarSystemId: number }).solarSystemId === C,
    )!;
    expect(jumpC.data).toMatchObject({ jumped: true, previousSystemId: B });
    const afterJumpC = tab.frames.slice(tab.frames.indexOf(jumpC));
    expect(afterJumpC.filter((frame) => frame.event === 'intel').every((frame) => bubbleOrigin(frame) === C)).toBe(true);

    // Pursuit: the same shooter in two systems the pilot just passed through.
    // The bubble around C is {B, C, D}; kills in B and C by one attacker.
    const advisoriesBefore = of(tab, 'advisory').length;
    await feedKill(B, { attacker: 666 });
    await feedKill(C, { attacker: 666 });
    await advance(2_000);
    const pursuit = of(tab, 'advisory').slice(advisoriesBefore)
      .find((frame) => (frame.data.advisory as { rule: string }).rule === 'pursuit');
    expect(pursuit?.data.advisory).toMatchObject({ severity: 'danger' });
    expect(threadAdvisories(threadIdSeen).map((entry) => entry.rule)).toContain('pursuit');

    // The radar then *understands*: one model-written assessment follows the
    // danger alarm, built from the live picture, persisted and billed.
    await until(() => of(tab, 'advisory').some((frame) => frame.data.escalated === true), 'model assessment');
    const assessment = of(tab, 'advisory').find((frame) => frame.data.escalated === true)!;
    expect((assessment.data.message as { content: string }).content).toContain('Тебя ведут от B');
    expect(modelCalls.count).toBe(1);
    expect(modelCalls.facts[0]).toContain('Pilot position:');
    expect(modelCalls.facts[0]).toContain('pursuit');
    const authored = readPerimeterHistory(db, threadIdSeen!, 200)
      .filter((message) => message.meta?.kind === 'advisory' && message.meta.authored === 'model');
    expect(authored).toHaveLength(1);
    expect(db.prepare('SELECT input_tokens FROM usage_events').all()).toEqual([{ input_tokens: 900 }]);
    // Another danger inside the LLM cooldown: rules still speak, the model does not.
    await feedKill(C, { attacker: 666, value: 5_000_000_000 });
    await advance(2_000);
    expect(modelCalls.count).toBe(1);

    // Offline: the online check runs once a minute.
    script.online = false;
    await advance(61_000, 1_000);
    await until(() => of(tab, 'offline').length === 1, 'offline frame');

    // ESI failure → a non-fatal warning and backoff: no location poll inside
    // the backoff window.
    script.online = true;
    script.esiFail = 'ESI 502';
    const warningsBefore = of(tab, 'warning').length;
    await advance(5_000, 500);
    await until(() => of(tab, 'warning').length === warningsBefore + 1, 'non-fatal warning');
    expect(of(tab, 'warning').at(-1)!.data).toMatchObject({ message: 'ESI 502', fatal: false });
    const callsAtFailure = script.locationCalls;
    await advance(5_000, 500);
    expect(script.locationCalls).toBe(callsAtFailure);

    // Recovery: the next poll after the backoff resumes positions.
    script.esiFail = null;
    const locationsBefore = of(tab, 'location').length;
    await advance(10_000, 500);
    await until(() => of(tab, 'location').length > locationsBefore, 'location after recovery');
    expect(tab.ended).toBe(false);

    // Three consecutive failures → fatal warning and the stream closes.
    script.esiFail = 'ESI 503';
    await advance(120_000, 1_000);
    await until(() => tab.ended, 'stream closed after fatal failures');
    const fatal = of(tab, 'warning').at(-1)!;
    expect(fatal.data.fatal).toBe(true);
    expect(String(fatal.data.message)).toContain('3 consecutive ESI failures');

    // Nothing left behind: no poller, no subscriber, advisor ref released,
    // and — once the feed poller is stopped — not a single timer.
    await flushIo();
    expect(getLiveSessionStats()).toEqual({ sessions: 0, subscribers: 0 });
    expect(sharedAdvisorRefsForTests(CHARACTER_ID)).toBe(0);
    await stopEveKillFeedPoller();
    resetMapKillIndexForTests();
    expect(vi.getTimerCount()).toBe(0);
  }, 30_000);

  it('shares one poller across tabs, and both tabs hear an advisory said once', async () => {
    const first = await openLive();
    await until(() => of(first, 'intel').length >= 1, 'first tab intel');
    const second = await openLive();
    await until(() => of(second, 'intel').length >= 1, 'second tab intel');
    expect(getLiveSessionStats()).toEqual({ sessions: 1, subscribers: 2 });
    expect(bubbleOrigin(of(second, 'intel')[0]!)).toBe(A);

    // One poll per tick for both tabs.
    const calls = script.locationCalls;
    await advance(5_000);
    expect(script.locationCalls).toBe(calls + 1);

    const big = await feedKill(B, { value: 4_000_000_000 });
    await advance(2_000);
    for (const tab of [first, second]) {
      expect(of(tab, 'kill').map((frame) => (frame.data.kill as { killmailId: number }).killmailId)).toEqual([big]);
      const said = rules(tab, 'value_spike').map((frame) => frame.data.advisory as { repeats: number });
      expect(said).toEqual([expect.objectContaining({ repeats: 0 })]);
    }
    // Both tabs got every advisory, and each was persisted once.
    expect(of(second, 'advisory').map((frame) => frame.id === null ? null : (frame.data.message as { id: number }).id))
      .toEqual(of(first, 'advisory').map((frame) => (frame.data.message as { id: number }).id));
    const threadId = of(first, 'ready')[0]!.data.threadId as string;
    const spikesInThread = () => threadAdvisories(threadId).filter((entry) => entry.rule === 'value_spike');
    expect(spikesInThread()).toEqual([{ rule: 'value_spike', repeats: 0 }]);
    expect(threadAdvisories(threadId)).toHaveLength(of(first, 'advisory').length);

    // The next genuine spike after the cooldown is not reported as a repeat
    // of the tab-duplicated evaluation.
    await advance(125_000, 1_000);
    await feedKill(B, { value: 6_000_000_000 });
    await advance(2_000);
    expect(spikesInThread()).toEqual([
      { rule: 'value_spike', repeats: 0 },
      { rule: 'value_spike', repeats: 0 },
    ]);

    first.close();
    await until(() => getLiveSessionStats().subscribers === 1, 'first tab detached');
    expect(getLiveSessionStats().sessions).toBe(1);
    expect(sharedAdvisorRefsForTests(CHARACTER_ID)).toBe(1);
    second.close();
    await until(() => getLiveSessionStats().sessions === 0, 'poller stopped');
    expect(sharedAdvisorRefsForTests(CHARACTER_ID)).toBe(0);
  }, 30_000);

  it('does not lose a kill that lands before the first bubble, nor publish a bubble the pilot jumped out of', async () => {
    // Hold the first build open.
    const gate = deferred();
    script.buildGate = gate.promise;
    const tab = await openLive();
    await until(() => of(tab, 'location').length === 1, 'first location');
    expect(of(tab, 'intel')).toHaveLength(0);

    // A kill next door while nothing is built yet.
    const early = await feedKill(B, { value: 2_500_000_000 });
    expect(of(tab, 'kill')).toHaveLength(0);

    // And the pilot jumps to B before that build finishes.
    script.systemId = B;
    await advance(5_000);
    await until(() => of(tab, 'location').length === 2, 'jump location');

    script.buildGate = null;
    gate.resolve();
    await until(() => of(tab, 'intel').length >= 1, 'intel after gate');
    await advance(500);
    // The A bubble is never published; the first intel is centred on B.
    expect(of(tab, 'intel').map(bubbleOrigin)).toEqual([B]);
    // The early kill is announced after the bubble that contains it, and judged.
    expect(of(tab, 'kill').map((frame) => (frame.data.kill as { killmailId: number }).killmailId)).toEqual([early]);
    expect(indexOf(tab, (frame) => frame.event === 'kill'))
      .toBeGreaterThan(indexOf(tab, (frame) => frame.event === 'intel'));
    expect(of(tab, 'advisory').map((frame) => (frame.data.advisory as { rule: string }).rule)).toContain('value_spike');
    tab.close();
    await until(() => getLiveSessionStats().sessions === 0, 'poller stopped');
  }, 30_000);

  it('says so when the kill feed goes stale instead of looking quietly clear', async () => {
    const tab = await openLive();
    await until(() => of(tab, 'intel').length >= 1, 'first intel');
    script.feedFail = 'EVE-KILL 503';
    // Intel ticks every 15 s; the feed is considered stale after 90 s.
    await advance(120_000, 1_000);
    const layer = (of(tab, 'intel').at(-1)!.data.bubble as {
      freshness: Array<{ layer: string; status: string; error: string | null }>;
    }).freshness.find((entry) => entry.layer === 'kills')!;
    expect(layer.status).toBe('cached');
    expect(layer.error).toContain('stale');
    tab.close();
    await until(() => getLiveSessionStats().sessions === 0, 'poller stopped');
  }, 30_000);

  it('keeps the radar alive while the pilot watches, and times out a forgotten tab', async () => {
    const tab = await openLive();
    await until(() => of(tab, 'intel').length > 0, 'first intel');

    const touch = async (headers: Record<string, string>) => app.inject({
      method: 'POST', url: '/api/web/map/live/touch', headers,
    });
    // CSRF-guarded like every map mutation.
    expect((await touch({ cookie })).statusCode).toBe(403);
    const ok = { cookie, origin: ORIGIN, 'x-csrf-token': csrfToken };

    // Sitting still for well past the idle window, touched every 4 minutes.
    for (let minute = 0; minute < 20; minute += 4) {
      expect((await touch(ok)).statusCode).toBe(204);
      await advance(4 * 60_000, 5_000);
    }
    expect(tab.ended).toBe(false);

    // Stop touching (tab hidden): the lease runs out and the stream closes.
    await advance(16 * 60_000, 5_000);
    await until(() => tab.ended, 'idle stop');
    expect((await touch(ok)).statusCode).toBe(404);
  }, 30_000);
});

