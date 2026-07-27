import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { config } from '../../src/config.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import {
  registerMarketAiSearchRoutes,
  type MarketAiSearchRunner,
} from '../../src/web/market-ai-search-routes.js';
import type { MarketAiSearchOutcome } from '../../src/agent/market-ai-search.js';
import type { UserContext } from '../../src/auth/user-resolver.js';
import {
  createWebSession,
  resetWebSessionCreationGuardForTests,
  WEB_SESSION_COOKIE,
} from '../../src/web/web-session.js';

let db: Database.Database;
let app: ReturnType<typeof Fastify>;
let runner: ReturnType<typeof vi.fn<MarketAiSearchRunner>>;

const ORIGIN = 'http://localhost:3000';
const FORGE = 10000002;
const TRITANIUM = 34;
const RIFTER = 587;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  runner = vi.fn<MarketAiSearchRunner>();
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerMarketAiSearchRoutes(app, db, runner);
});

afterEach(async () => {
  await app.close();
  db.close();
});

function browserSession(): { cookie: string; csrf: string; userId: number } {
  const created = createWebSession(db);
  return {
    cookie: `${WEB_SESSION_COOKIE}=${created.sessionToken}`,
    csrf: created.csrfToken,
    userId: created.userId,
  };
}

function mutationHeaders(session: { cookie: string; csrf: string }) {
  return {
    origin: ORIGIN,
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };
}

function okOutcome(picks: Array<{ type_id: number; reason: string }>): MarketAiSearchOutcome {
  return {
    ok: true,
    picks,
    usage: { input: 120, output: 40, cached: 10, cacheWrite: 0, reasoning: 5 },
  };
}

function seedType(typeId: number, name: string): void {
  db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, NULL, ?)')
    .run(typeId, name, JSON.stringify({ published: 1, marketGroupID: 5 }));
}

function seedOrder(orderId: number, typeId: number, isBuy: number, price: number): void {
  db.prepare(`
    INSERT INTO market_orders (
      order_id, type_id, region_id, system_id, station_id, location_id,
      is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued
    ) VALUES (?, ?, ?, 30000142, NULL, 60003760, ?, ?, 100, 100, 1, 90, 'region', '2026-07-27T09:55:00Z')
  `).run(orderId, typeId, FORGE, isBuy, price);
}

describe('market ai-search route', () => {
  it('requires a browser session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      payload: { query: 'дешёвый фрегат' },
    });
    expect(response.statusCode).toBe(401);
    expect(runner).not.toHaveBeenCalled();
  });

  it('requires the CSRF/origin mutation check', async () => {
    const session = browserSession();
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: { cookie: session.cookie },
      payload: { query: 'дешёвый фрегат' },
    });
    expect(response.statusCode).toBe(403);
    expect(runner).not.toHaveBeenCalled();
  });

  it('validates the body, query length and region', async () => {
    const session = browserSession();
    const cases: Array<{ payload: Record<string, unknown>; error: string }> = [
      { payload: {}, error: 'Запрос должен содержать от 2 до 500 символов.' },
      { payload: { query: 'ф' }, error: 'Запрос должен содержать от 2 до 500 символов.' },
      { payload: { query: '  ' }, error: 'Запрос должен содержать от 2 до 500 символов.' },
      { payload: { query: 'x'.repeat(501) }, error: 'Запрос должен содержать от 2 до 500 символов.' },
      { payload: { query: 'фрегат', region_id: 'jita' }, error: 'Некорректный регион.' },
      { payload: { query: 'фрегат', region_id: -5 }, error: 'Некорректный регион.' },
    ];
    for (const { payload, error } of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/web/market/ai-search',
        headers: mutationHeaders(session),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error });
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('hydrates picks with names and local snapshot prices, and records usage as web', async () => {
    seedType(TRITANIUM, 'Tritanium');
    seedType(RIFTER, 'Rifter');
    seedOrder(1, RIFTER, 0, 300_000);
    seedOrder(2, RIFTER, 0, 295_000);
    seedOrder(3, RIFTER, 1, 280_000);
    runner.mockResolvedValue(okOutcome([
      { type_id: RIFTER, reason: 'Дешёвый боевой фрегат.' },
      { type_id: 999_999, reason: 'Нет в SDE — отбрасывается.' },
      { type_id: TRITANIUM, reason: 'Минерал без ордеров.' },
    ]));

    const session = browserSession();
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(session),
      payload: { query: 'дешёвый фрегат для соло-пвп' },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      ok: boolean;
      results: Array<{ type_id: number; name: string; reason: string; best_sell: number | null; best_buy: number | null }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.results).toEqual([
      { type_id: RIFTER, name: 'Rifter', reason: 'Дешёвый боевой фрегат.', best_sell: 295_000, best_buy: 280_000 },
      { type_id: TRITANIUM, name: 'Tritanium', reason: 'Минерал без ордеров.', best_sell: null, best_buy: null },
    ]);

    // Раннер получил контекст именно этой сессии и дефолтный регион из конфига.
    expect(runner).toHaveBeenCalledTimes(1);
    const [, query, ctx, regionId] = runner.mock.calls[0]!;
    expect(query).toBe('дешёвый фрегат для соло-пвп');
    expect((ctx as UserContext).userId).toBe(session.userId);
    expect(regionId).toBe(FORGE);

    const usage = db.prepare(
      'SELECT user_id, thread_id, channel, input_tokens, output_tokens FROM usage_events',
    ).all() as Array<{ user_id: number; thread_id: string; channel: string; input_tokens: number; output_tokens: number }>;
    expect(usage).toEqual([{
      user_id: session.userId,
      thread_id: 'web-market-ai-search',
      channel: 'web',
      input_tokens: 120,
      output_tokens: 40,
    }]);
  });

  it('honours an explicit region_id', async () => {
    seedType(RIFTER, 'Rifter');
    runner.mockResolvedValue(okOutcome([{ type_id: RIFTER, reason: '' }]));
    const session = browserSession();
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(session),
      payload: { query: 'фрегат', region_id: 10000043 },
    });
    expect(response.statusCode).toBe(200);
    expect(runner.mock.calls[0]![3]).toBe(10000043);
  });

  it('degrades honestly when the model is unavailable', async () => {
    runner.mockResolvedValue({ ok: false, picks: [], usage: null });
    const session = browserSession();
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(session),
      payload: { query: 'чем стрелять по армору' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Модель сейчас недоступна. Попробуйте повторить через минуту.' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM usage_events').get()).toEqual({ count: 0 });
  });

  it('keeps sessions isolated: each call runs under its own user', async () => {
    seedType(RIFTER, 'Rifter');
    runner.mockResolvedValue(okOutcome([{ type_id: RIFTER, reason: '' }]));
    const first = browserSession();
    const second = browserSession();

    await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(first),
      payload: { query: 'фрегат' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(second),
      payload: { query: 'фрегат' },
    });

    const userIds = runner.mock.calls.map((call) => (call[2] as UserContext).userId);
    expect(userIds).toEqual([first.userId, second.userId]);
    const rows = db.prepare('SELECT user_id FROM usage_events ORDER BY event_id').all() as Array<{ user_id: number }>;
    expect(rows.map((row) => row.user_id)).toEqual([first.userId, second.userId]);
  });

  it('passes through the shared admission: exhausted user window answers 429 without calling the model', async () => {
    const session = browserSession();
    const insert = db.prepare(`
      INSERT INTO web_admission_events (event_id, event_kind, user_id, ip_key, cost_units, created_at_ms)
      VALUES (?, 'ai-search', ?, 'ip1:test', 1, ?)
    `);
    for (let index = 0; index < config.web.maxRequestsPerUserWindow; index += 1) {
      insert.run(`spent-${index}`, session.userId, Date.now());
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(session),
      payload: { query: 'фрегат' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe(String(config.web.requestWindowSeconds));
    expect(runner).not.toHaveBeenCalled();
    // Отказ не тратит бюджет: новых admission-событий нет.
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM web_admission_events WHERE event_kind = 'ai-search'
    `).get()).toEqual({ count: config.web.maxRequestsPerUserWindow });
  });

  it('spends from the same operator cost-unit budgets as the chat', async () => {
    const session = browserSession();
    // Пользовательский пул WEB_MAX_COST_UNITS_PER_USER_WINDOW исчерпан чатом —
    // ai-search тоже стоит, а не горит мимо бюджета.
    db.prepare(`
      INSERT INTO web_admission_events (event_id, event_kind, user_id, ip_key, cost_units, created_at_ms)
      VALUES ('chat-spend', 'chat', ?, 'ip1:test', ?, ?)
    `).run(session.userId, config.web.maxCostUnitsPerUserWindow, Date.now());

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(session),
      payload: { query: 'фрегат' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it('records an ai-search admission event with cost units on acceptance', async () => {
    seedType(RIFTER, 'Rifter');
    runner.mockResolvedValue(okOutcome([{ type_id: RIFTER, reason: '' }]));
    const session = browserSession();

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(session),
      payload: { query: 'фрегат' },
    });

    expect(response.statusCode).toBe(200);
    const events = db.prepare(`
      SELECT event_kind, user_id, cost_units FROM web_admission_events WHERE event_kind = 'ai-search'
    `).all() as Array<{ event_kind: string; user_id: number; cost_units: number }>;
    expect(events).toEqual([{ event_kind: 'ai-search', user_id: session.userId, cost_units: 2 }]);
  });

  it('answers a sanitized 503 with Retry-After when the runner throws, without provider internals', async () => {
    runner.mockRejectedValue(new Error('Responses admission queue is full at https://provider.internal.example/v1'));
    const session = browserSession();

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(session),
      payload: { query: 'фрегат' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBeDefined();
    const body = response.body;
    expect(body).not.toContain('admission');
    expect(body).not.toContain('provider.internal.example');
    expect(response.json()).toEqual({ error: 'Модель сейчас недоступна. Попробуйте повторить через минуту.' });
  });

  it('sets Retry-After on the plain degradation 503 as well', async () => {
    runner.mockResolvedValue({ ok: false, picks: [], usage: null });
    const session = browserSession();
    const response = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(session),
      payload: { query: 'фрегат' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBeDefined();
  });

  it('can be switched off by the operator without touching the chat', async () => {
    const original = config.web.aiSearchEnabled;
    config.web.aiSearchEnabled = false;
    try {
      const session = browserSession();
      const response = await app.inject({
        method: 'POST',
        url: '/api/web/market/ai-search',
        headers: mutationHeaders(session),
        payload: { query: 'фрегат' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBeDefined();
      expect(runner).not.toHaveBeenCalled();
    } finally {
      config.web.aiSearchEnabled = original;
    }
  });

  it('rejects region_id outside the public trade regions once the SDE is loaded', async () => {
    db.prepare("INSERT INTO sde_regions (region_id, name, data_json) VALUES (10000043, 'Domain', '{}')").run();
    db.prepare("INSERT INTO sde_constellations (constellation_id, name, region_id, data_json) VALUES (20000001, 'Throne Worlds', 10000043, '{}')").run();
    db.prepare("INSERT INTO sde_systems (system_id, name, constellation_id, data_json) VALUES (30000142, 'Amarr', 20000001, '{}')").run();
    db.prepare("INSERT INTO sde_stargates (stargate_id, system_id, data_json) VALUES (50000001, 30000142, '{}')").run();
    seedType(RIFTER, 'Rifter');
    runner.mockResolvedValue(okOutcome([{ type_id: RIFTER, reason: '' }]));
    const session = browserSession();

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(session),
      payload: { query: 'фрегат', region_id: FORGE },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'Некорректный регион.' });
    expect(runner).not.toHaveBeenCalled();

    const valid = await app.inject({
      method: 'POST',
      url: '/api/web/market/ai-search',
      headers: mutationHeaders(session),
      payload: { query: 'фрегат', region_id: 10000043 },
    });
    expect(valid.statusCode).toBe(200);
    expect(runner.mock.calls[0]![3]).toBe(10000043);
  });
});
