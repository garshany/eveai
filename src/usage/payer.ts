import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../db/sqlite.js';
import type { NativeUsage } from '../agent/native-responses.js';
import { recordModelUsageSafe } from './tracker.js';
import type { UsageTokenCounts } from './pricing.js';

/**
 * Who pays for an internal model call: the user/chat lane whose request or
 * background job caused it, plus a stable thread label for usage_events.
 *
 * There is no separate operator ledger: work with no resolvable owner (e.g. a
 * route monitor whose chat lane has no linked user) is recorded under
 * SYSTEM_USAGE_USER_ID. user_id is AUTOINCREMENT from 1, so 0 never matches a
 * signed-in user's "my spend" row, yet the event still counts in the public
 * all-users transparency totals — spend is never silently dropped.
 */
export type UsagePayer = {
  db: Db;
  userId: number;
  chatId?: number;
  threadId: string;
};

export const SYSTEM_USAGE_USER_ID = 0;

export function toUsageCounts(usage: NativeUsage): UsageTokenCounts {
  return {
    input: usage.input,
    output: usage.output,
    cached: usage.cached,
    cacheWrite: usage.cacheWrite ?? 0,
    reasoning: usage.reasoning,
  };
}

/** Non-fatal: accounting never breaks the caller (see recordModelUsageSafe). */
export function recordPayerUsage(payer: UsagePayer, usage: NativeUsage, model: string): void {
  recordModelUsageSafe(
    payer.db,
    { userId: payer.userId, chatId: payer.chatId },
    payer.threadId,
    toUsageCounts(usage),
    model,
  );
}

/**
 * Ambient payer for model calls made deep inside tool code whose signatures
 * do not carry a user (e.g. OSINT inference). The executor wraps tool
 * dispatch in runWithUsagePayer(); AsyncLocalStorage scopes it per turn, so
 * concurrent turns never bill each other.
 */
const storage = new AsyncLocalStorage<UsagePayer>();

export function runWithUsagePayer<T>(payer: UsagePayer, fn: () => Promise<T>): Promise<T> {
  return storage.run(payer, fn);
}

export function getUsagePayer(): UsagePayer | undefined {
  return storage.getStore();
}
