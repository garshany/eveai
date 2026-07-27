import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { registerWebChatRoutes } from '../../src/web/chat-routes.js';
import { recordUsageEvent } from '../../src/usage/tracker.js';
import { rollupUsageEvents } from '../../src/usage/rollup.js';
import { resetGcpBillingForTests } from '../../src/usage/gcp-billing.js';
import { resetWebSessionCreationGuardForTests } from '../../src/web/web-session.js';

const ORIGIN = 'http://localhost:3000';

let db: Database.Database;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  resetWebSessionCreationGuardForTests();
  resetGcpBillingForTests();
  app = Fastify({ bodyLimit: 64 * 1024 });
  await app.register(fastifyCookie);
  registerWebChatRoutes(app, db);
});

afterEach(async () => {
  await app.close();
  db.close();
  resetGcpBillingForTests();
});

function addEvent(overrides: {
  createdAtMs?: number;
  userId: number;
  model?: string;
  input?: number;
  output?: number;
  costMicros?: number | null;
}): void {
  recordUsageEvent(db, {
    createdAtMs: overrides.createdAtMs ?? Date.now(),
    userId: overrides.userId,
    threadId: 'thread-1',
    channel: 'web',
    model: overrides.model ?? 'model-a',
    usage: {
      input: overrides.input ?? 0,
      output: overrides.output ?? 0,
      cached: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
    costMicros: overrides.costMicros ?? null,
  });
}

async function createBrowserSession(): Promise<{ cookie: string; userId: number }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/web/session',
    headers: { origin: ORIGIN },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie']
    : [response.headers['set-cookie'] as string];
  const cookie = setCookie.map((value) => value.split(';', 1)[0]).join('; ');
  const row = db.prepare('SELECT user_id FROM web_sessions ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get() as { user_id: number };
  return { cookie, userId: row.user_id };
}

describe('GET /api/web/transparency (public)', () => {
  it('answers without a session, with a short public cache header', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/transparency' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    const body = response.json();
    expect(body.currency).toBe('USD');
    expect(body.currentModel).toBe('gpt-5.6-sol');
    expect(body.daily).toHaveLength(30);
    expect(body.donations).toEqual({ boostyUrl: 'https://boosty.to/artemy1337' });
    expect(body.fx).toBeNull();
  });

  it('aggregates over every user without exposing any per-user row', async () => {
    addEvent({ userId: 1, input: 100, output: 10, costMicros: 1000 });
    addEvent({ userId: 2, input: 9000, output: 900, model: 'model-b', costMicros: null });
    addEvent({ userId: 1, input: 50, output: 5, createdAtMs: Date.now() - 86_400_000, costMicros: 500 });
    rollupUsageEvents(db);

    const response = await app.inject({ method: 'GET', url: '/api/web/transparency' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.totals.inputTokens).toBe(9150);
    expect(body.totals.outputTokens).toBe(915);
    expect(body.totals.events).toBe(3);
    expect(body.totals.costMicros).toBe(1500); // known costs only
    expect(body.totals.unknownCostEvents).toBe(1);
    expect(body.totals.costComplete).toBe(false);

    // Privacy: nothing in the public payload is keyed by or identifies a user.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('userId');
    expect(serialized).not.toContain('user_id');

    // Models carry token splits and an explicit null tariff (never a fake 0).
    const modelB = body.models.find((entry: { model: string }) => entry.model === 'model-b');
    expect(modelB).toMatchObject({ inputTokens: 9000, tariff: null, unknownCostEvents: 1 });
  });

  it('reports the billing export state explicitly and falls back to a labeled estimate', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/transparency' });
    const infra = response.json().infrastructure;

    expect(infra.status).toBe('not_configured');
    expect(infra.monthToDateUsd).toBeNull();
    expect(infra.estimate.monthlyUsd).toBe(19);
    expect(infra.estimate.components.length).toBeGreaterThan(0);
    expect(infra.estimate.note).toContain('Оценка');
  });
});

describe('GET /api/web/transparency/me (personal)', () => {
  it('rejects anonymous callers and stays no-store', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/web/transparency/me' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('shows the caller only their own spend', async () => {
    const first = await createBrowserSession();
    const second = await createBrowserSession();
    addEvent({ userId: first.userId, input: 100, output: 10, costMicros: 1000 });
    addEvent({ userId: second.userId, input: 9000, output: 900, model: 'model-b', costMicros: 2000 });

    const ownResponse = await app.inject({
      method: 'GET',
      url: '/api/web/transparency/me',
      headers: { cookie: first.cookie },
    });
    expect(ownResponse.statusCode).toBe(200);
    expect(ownResponse.headers['cache-control']).toBe('no-store');
    const own = ownResponse.json();
    expect(own.totals.inputTokens).toBe(100);
    expect(own.totals.events).toBe(1);
    expect(own.totals.costMicros).toBe(1000);
    // The other user's 9000-token model never appears in this caller's cuts.
    expect(own.models.map((entry: { model: string }) => entry.model)).toEqual(['model-a']);

    const otherResponse = await app.inject({
      method: 'GET',
      url: '/api/web/transparency/me',
      headers: { cookie: second.cookie },
    });
    expect(otherResponse.json().totals.inputTokens).toBe(9000);
    expect(otherResponse.json().totals.events).toBe(1);
  });
});
