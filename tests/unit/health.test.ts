import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  markTelegramBotHealthFailed,
  markTelegramBotHealthReady,
  markTelegramBotHealthStarting,
  registerHealthRoute,
  resetTelegramBotHealth,
} from '../../src/web/health.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';

let db: Database.Database;
let tempDir: string;

beforeEach(() => {
  resetTelegramBotHealth();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(async () => {
  resetTelegramBotHealth();
  db.close();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('health route', () => {
  it('returns ok when the bot is ready', async () => {
    const app = Fastify();
    registerHealthRoute(app, {
      db,
      clientManifestPath: await createManifest(),
    });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'ok',
      checks: {
        telegram_bot: { status: 'ok' },
        database: { status: 'ok' },
        client_assets: { status: 'ok' },
        openai_proxy: { status: 'skipped' },
      },
    });

    await app.close();
  });

  it('returns 503 while the bot is starting', async () => {
    const app = Fastify();
    markTelegramBotHealthStarting();
    registerHealthRoute(app, {
      db,
      clientManifestPath: await createManifest(),
    });

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
    registerHealthRoute(app, {
      db,
      clientManifestPath: await createManifest(),
    });

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
    registerHealthRoute(app, {
      db,
      clientManifestPath: await createManifest(),
    });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'ok',
    });

    await app.close();
  });

  it('returns degraded when a dependency check fails', async () => {
    const app = Fastify();
    registerHealthRoute(app, {
      db,
      clientManifestPath: await createManifest(),
      openaiBaseUrl: 'http://localhost:8088/v1',
      fetchImpl: async () => new Response(null, { status: 503 }),
    });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'degraded',
      checks: {
        openai_proxy: { status: 'failed' },
      },
    });

    await app.close();
  });
});

async function createManifest(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'eveai-health-'));
  const manifestPath = join(tempDir, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      'client/src/main.tsx': { file: 'assets/main.js' },
    }),
    'utf8',
  );
  return manifestPath;
}
