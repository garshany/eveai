import { config } from '../config.js';

const DEFAULT_REQUEST_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 6;
const DEFAULT_MAX_ACTIVE_REQUESTS = 24;

const recentRequestStarts = new Map<string, number[]>();

export interface TelegramRequestAllowanceInput {
  chatId: number;
  userId: number;
  hasActiveRequest: boolean;
  activeRequestCount: number;
  now?: number;
}

export interface TelegramRequestAllowance {
  ok: boolean;
  message: string | null;
}

export function evaluateTelegramRequestAllowance(input: TelegramRequestAllowanceInput): TelegramRequestAllowance {
  if (input.hasActiveRequest) {
    return {
      ok: false,
      message: 'Предыдущий запрос ещё обрабатывается. Дождись ответа и попробуй снова.',
    };
  }

  const maxActiveRequests = normalizePositiveInt(
    config.telegram.maxActiveRequestsGlobal,
    DEFAULT_MAX_ACTIVE_REQUESTS,
  );
  if (input.activeRequestCount >= maxActiveRequests) {
    return {
      ok: false,
      message: 'Сервис сейчас перегружен. Попробуй ещё раз чуть позже.',
    };
  }

  const now = input.now ?? Date.now();
  const windowMs = normalizePositiveInt(config.telegram.requestWindowMs, DEFAULT_REQUEST_WINDOW_MS);
  const maxRequestsPerWindow = normalizePositiveInt(
    config.telegram.maxRequestsPerWindow,
    DEFAULT_MAX_REQUESTS_PER_WINDOW,
  );

  const key = buildActorKey(input.chatId, input.userId);
  const recent = pruneRecentRequests(recentRequestStarts.get(key) ?? [], now, windowMs);
  if (recent.length >= maxRequestsPerWindow) {
    recentRequestStarts.set(key, recent);
    return {
      ok: false,
      message: `Слишком много запросов за короткое время. Подожди ${Math.ceil(windowMs / 1000)} секунд и попробуй снова.`,
    };
  }

  recent.push(now);
  recentRequestStarts.set(key, recent);
  return { ok: true, message: null };
}

export function resetTelegramRequestGuardForTests(): void {
  recentRequestStarts.clear();
}

function buildActorKey(chatId: number, userId: number): string {
  return userId > 0 ? `u:${userId}` : `c:${chatId}`;
}

function pruneRecentRequests(values: number[], now: number, windowMs: number): number[] {
  return values.filter((value) => now - value < windowMs);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.round(value);
}
