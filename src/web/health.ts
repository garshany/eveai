import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/sqlite.js';

export type TelegramBotHealthStatus = 'ok' | 'starting' | 'failed';
export type DependencyHealthStatus = 'ok' | 'failed' | 'skipped';

type TelegramBotHealth = {
  status: TelegramBotHealthStatus;
  error: string | null;
};

export type DependencyHealthCheck = {
  status: DependencyHealthStatus;
  error?: string;
  details?: Record<string, unknown>;
};

export interface HealthRouteOptions {
  db?: Db;
  clientManifestPath?: string;
  openaiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ClientManifestEntry {
  file: string;
}

const OK_HEALTH: TelegramBotHealth = {
  status: 'ok',
  error: null,
};

const DEFAULT_CLIENT_MANIFEST_PATH = resolve(process.cwd(), 'dist/client/.vite/manifest.json');
const CLIENT_ENTRY_KEY = 'client/src/main.tsx';
const HEALTH_TIMEOUT_MS = 2_000;

let telegramBotHealth: TelegramBotHealth = { ...OK_HEALTH };

export function resetTelegramBotHealth(): void {
  telegramBotHealth = { ...OK_HEALTH };
}

export function markTelegramBotHealthStarting(): void {
  telegramBotHealth = {
    status: 'starting',
    error: null,
  };
}

export function markTelegramBotHealthReady(): void {
  telegramBotHealth = { ...OK_HEALTH };
}

export function markTelegramBotHealthFailed(error: unknown): void {
  telegramBotHealth = {
    status: 'failed',
    error: stringifyError(error),
  };
}

export function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions = {}): void {
  app.get('/health', async (_req, reply) => {
    const checks = await collectDependencyChecks(options);
    const dependencyFailures = Object.values(checks).some((check) => check.status === 'failed');
    const botHealthy = telegramBotHealth.status === 'ok';
    const statusCode = botHealthy && !dependencyFailures ? 200 : 503;

    return reply.status(statusCode).send({
      status: statusCode === 200 ? 'ok' : telegramBotHealth.status === 'ok' ? 'degraded' : telegramBotHealth.status,
      timestamp: new Date().toISOString(),
      error: telegramBotHealth.error ?? undefined,
      checks: {
        telegram_bot: {
          status: telegramBotHealth.status,
          error: telegramBotHealth.error ?? undefined,
        },
        ...checks,
      },
    });
  });
}

async function collectDependencyChecks(options: HealthRouteOptions): Promise<Record<string, DependencyHealthCheck>> {
  const [database, clientAssets, openaiProxy] = await Promise.all([
    checkDatabase(options.db),
    checkClientAssets(options.clientManifestPath ?? DEFAULT_CLIENT_MANIFEST_PATH),
    checkOpenAiProxy(options.openaiBaseUrl ?? '', options.fetchImpl ?? fetch),
  ]);

  return {
    database,
    client_assets: clientAssets,
    openai_proxy: openaiProxy,
  };
}

async function checkDatabase(db?: Db): Promise<DependencyHealthCheck> {
  if (!db) {
    return { status: 'skipped' };
  }

  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    if (row?.ok !== 1) {
      return { status: 'failed', error: 'Unexpected SQLite probe result' };
    }
    return { status: 'ok' };
  } catch (error) {
    return { status: 'failed', error: stringifyError(error) };
  }
}

async function checkClientAssets(manifestPath: string): Promise<DependencyHealthCheck> {
  try {
    await access(manifestPath);
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as Record<string, ClientManifestEntry>;
    const entry = manifest[CLIENT_ENTRY_KEY];
    if (!entry?.file) {
      return { status: 'failed', error: `Client manifest missing ${CLIENT_ENTRY_KEY}` };
    }
    return {
      status: 'ok',
      details: {
        manifest: manifestPath,
        entry: entry.file,
      },
    };
  } catch (error) {
    return { status: 'failed', error: stringifyError(error) };
  }
}

async function checkOpenAiProxy(baseUrl: string, fetchImpl: typeof fetch): Promise<DependencyHealthCheck> {
  const healthUrl = deriveOpenAiHealthUrl(baseUrl);
  if (!healthUrl) {
    return { status: 'skipped' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(healthUrl, { signal: controller.signal });
    if (!response.ok) {
      return { status: 'failed', error: `Health probe returned HTTP ${response.status}` };
    }
    return {
      status: 'ok',
      details: {
        url: healthUrl,
      },
    };
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return { status: 'failed', error: `Health probe timed out after ${HEALTH_TIMEOUT_MS}ms` };
    }
    return { status: 'failed', error: stringifyError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function deriveOpenAiHealthUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.hostname === 'api.openai.com') {
      return null;
    }

    const normalizedPath = url.pathname.replace(/\/+$/, '');
    url.pathname = normalizedPath.endsWith('/v1')
      ? `${normalizedPath.slice(0, -3) || ''}/health`
      : `${normalizedPath || ''}/health`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Telegram bot failed to start';
}
