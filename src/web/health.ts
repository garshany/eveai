import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/sqlite.js';

export type BotPlatform = 'telegram' | 'discord';
export type BotHealthStatus = 'ok' | 'starting' | 'failed' | 'disabled';
export type DependencyHealthStatus = 'ok' | 'failed' | 'skipped';

type PlatformHealth = {
  status: BotHealthStatus;
  error: string | null;
};

export type DependencyHealthCheck = {
  status: DependencyHealthStatus;
  error?: string;
  details?: Record<string, unknown>;
};

export interface HealthRouteOptions {
  db?: Db;
}

function defaultHealth(): Record<BotPlatform, PlatformHealth> {
  return {
    telegram: { status: 'ok', error: null },
    discord: { status: 'disabled', error: null },
  };
}

let botHealth = defaultHealth();

export function resetBotHealth(): void {
  botHealth = defaultHealth();
}

export function markBotDisabled(platform: BotPlatform): void {
  botHealth[platform] = { status: 'disabled', error: null };
}

export function markBotStarting(platform: BotPlatform): void {
  botHealth[platform] = { status: 'starting', error: null };
}

export function markBotReady(platform: BotPlatform): void {
  botHealth[platform] = { status: 'ok', error: null };
}

export function markBotFailed(platform: BotPlatform, error: unknown): void {
  botHealth[platform] = { status: 'failed', error: stringifyError(error) };
}

// Backward-compatible Telegram-named wrappers (used across app and tests).
export const resetTelegramBotHealth = resetBotHealth;
export const markTelegramBotHealthStarting = (): void => markBotStarting('telegram');
export const markTelegramBotHealthReady = (): void => markBotReady('telegram');
export const markTelegramBotHealthFailed = (error: unknown): void => markBotFailed('telegram', error);

export function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions = {}): void {
  app.get('/health', async (_req, reply) => {
    const checks = await collectDependencyChecks(options);
    const dependencyFailures = Object.values(checks).some((check) => check.status === 'failed');

    const enabled = (Object.keys(botHealth) as BotPlatform[])
      .filter((platform) => botHealth[platform].status !== 'disabled');
    const failedPlatform = enabled.find((platform) => botHealth[platform].status === 'failed');
    const startingPlatform = enabled.find((platform) => botHealth[platform].status === 'starting');

    const botsHealthy = !failedPlatform && !startingPlatform;
    const statusCode = botsHealthy && !dependencyFailures ? 200 : 503;
    const status = statusCode === 200
      ? 'ok'
      : failedPlatform
        ? 'failed'
        : startingPlatform
          ? 'starting'
          : 'degraded';
    const firstError = failedPlatform ? botHealth[failedPlatform].error : null;

    return reply.status(statusCode).send({
      status,
      timestamp: new Date().toISOString(),
      error: firstError ?? undefined,
      checks: {
        telegram_bot: platformCheck('telegram'),
        discord_bot: platformCheck('discord'),
        ...checks,
      },
    });
  });
}

function platformCheck(platform: BotPlatform): { status: string; error?: string } {
  const health = botHealth[platform];
  return {
    status: health.status === 'disabled' ? 'skipped' : health.status,
    error: health.error ?? undefined,
  };
}

async function collectDependencyChecks(options: HealthRouteOptions): Promise<Record<string, DependencyHealthCheck>> {
  return {
    database: await checkDatabase(options.db),
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

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Bot failed to start';
}
