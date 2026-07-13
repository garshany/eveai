import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import {
  markTelegramBotHealthFailed,
  markTelegramBotHealthReady,
  markTelegramBotHealthStarting,
  registerHealthRoute,
  resetTelegramBotHealth,
} from '../../src/web/health.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';

let db: Database.Database;

beforeEach(() => {
  resetTelegramBotHealth();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  resetTelegramBotHealth();
  db.close();
});

describe('health route', () => {
  it('returns ok when the bot is ready', async () => {
    const app = Fastify();
    registerHealthRoute(app, { db });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'ok',
      checks: {
        telegram_bot: { status: 'ok' },
        database: { status: 'ok' },
      },
    });

    await app.close();
  });

  it('returns 503 while the bot is starting', async () => {
    const app = Fastify();
    markTelegramBotHealthStarting();
    registerHealthRoute(app, { db });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'starting',
    });

    await app.close();
  });

  it('returns 503 when bot startup failed', async () => {
    const app = Fastify();
    markTelegramBotHealthFailed(new Error('telegram offline'));
    registerHealthRoute(app, { db });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'failed',
      error: 'telegram offline',
    });

    await app.close();
  });

  it('returns back to ok after readiness is restored', async () => {
    const app = Fastify();
    markTelegramBotHealthStarting();
    markTelegramBotHealthReady();
    registerHealthRoute(app, { db });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'ok',
    });

    await app.close();
  });

  it('returns degraded when a dependency check fails', async () => {
    const app = Fastify();
    const brokenDb = new Database(':memory:');
    brokenDb.close();
    registerHealthRoute(app, { db: brokenDb });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'degraded',
      checks: {
        database: { status: 'failed' },
      },
    });

    await app.close();
  });
});
