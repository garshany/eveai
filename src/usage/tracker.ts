import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { WEB_CHAT_ID_START } from '../web/web-session.js';
import { computeUsageCostMicros, type UsageTokenCounts } from './pricing.js';

export type UsageChannel = 'web' | 'telegram' | 'discord' | 'cli';

/**
 * Channel is derived from the chat lane id, never from request input:
 * 0 = local CLI, positives = Telegram, web sessions allocate downwards from
 * WEB_CHAT_ID_START, and the remaining small negatives are Discord lanes
 * (see web-session.ts and discord/session.ts).
 */
export function resolveUsageChannel(chatId: number): UsageChannel {
  if (chatId === 0) return 'cli';
  if (chatId > 0) return 'telegram';
  return chatId <= WEB_CHAT_ID_START ? 'web' : 'discord';
}

export type UsageEventInput = {
  createdAtMs: number;
  userId: number;
  threadId: string;
  channel: UsageChannel;
  model: string;
  usage: UsageTokenCounts;
  /** Integer microdollars; null when the model has no configured tariff. */
  costMicros: number | null;
};

export function recordUsageEvent(db: Db, event: UsageEventInput): void {
  db.prepare(`
    INSERT INTO usage_events (
      created_at_ms, user_id, thread_id, channel, model,
      input_tokens, output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens,
      cost_micros
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.createdAtMs,
    event.userId,
    event.threadId,
    event.channel,
    event.model,
    event.usage.input,
    event.usage.output,
    event.usage.cached,
    event.usage.cacheWrite,
    event.usage.reasoning,
    event.costMicros,
  );
}

/**
 * Accounting must never fail the user's turn — the same guarantee the
 * total_tokens update in executor.ts documents. Any failure here is logged
 * and swallowed; the answer to the user is already on its way.
 */
export function recordModelUsageSafe(
  db: Db,
  ctx: { userId: number; chatId?: number },
  threadId: string,
  usage: UsageTokenCounts,
  /**
   * The model actually sent to the provider this turn (per-user setting or
   * config default). Costs are priced by this id's tariff, so it must be the
   * applied model, never assumed from config — hence a required parameter.
   */
  model: string,
): void {
  try {
    recordUsageEvent(db, {
      createdAtMs: Date.now(),
      userId: ctx.userId,
      threadId,
      channel: resolveUsageChannel(ctx.chatId ?? 0),
      model,
      usage,
      costMicros: computeUsageCostMicros(usage, config.usage.pricing, model),
    });
  } catch (error) {
    console.warn('[usage] failed to record usage event: %s', error instanceof Error ? error.message : error);
  }
}
