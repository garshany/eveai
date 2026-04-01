/**
 * EVE-KILL tool call router.
 * Dispatches tool name → handler, returns JSON-serializable result.
 */

import type { Db } from '../db/sqlite.js';
import type { EveKillToolName } from './tools.js';
import { executeKillFeed } from './feed.js';
import { executeKillQuery } from './kill-query.js';
import { executeKillIntel } from './intel.js';
import { addWatch, removeWatch, removeAllWatches, listWatches } from './watch.js';

export async function executeEveKillTool(
  db: Db,
  name: EveKillToolName,
  args: Record<string, unknown>,
  chatId?: number,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'kill_feed':
      return await executeKillFeed(db, args) as unknown as Record<string, unknown>;
    case 'kill_query':
      return await executeKillQuery(db, args) as unknown as Record<string, unknown>;
    case 'kill_watch':
      return executeKillWatch(db, args, chatId);
    // All other tools route through kill_intel dispatcher with action mapping
    case 'kill_stats':
    case 'kill_battles':
    case 'kill_entity':
    case 'kill_lookup':
    case 'kill_spatial':
    case 'kill_prices':
      return await executeKillIntel(db, remapArgs(name, args)) as unknown as Record<string, unknown>;
  }
}

// ---------------------------------------------------------------------------
// kill_watch handler
// ---------------------------------------------------------------------------

function executeKillWatch(db: Db, args: Record<string, unknown>, chatId?: number): Record<string, unknown> {
  const action = args.action as string;

  if (!chatId) {
    return { ok: false, error: 'Kill watch requires a Telegram chat context.' };
  }

  if (action === 'list') {
    const watches = listWatches(db, chatId);
    return {
      ok: true,
      watches: watches.map((w) => ({ topic: w.topic, label: w.label, since: w.created_at })),
      count: watches.length,
    };
  }

  if (action === 'unwatch') {
    const topicType = args.topic_type as string | null;
    const topicId = args.topic_id as number | null;

    if (!topicType && !topicId) {
      // Remove all
      const count = removeAllWatches(db, chatId);
      return { ok: true, removed: count, message: `Removed all ${count} watches.` };
    }

    const topic = buildTopic(topicType, topicId);
    if (!topic) return { ok: false, error: 'Invalid topic_type or topic_id.' };

    const result = removeWatch(db, chatId, topic);
    return result.ok
      ? { ok: true, removed: topic }
      : { ok: false, error: result.error };
  }

  if (action === 'watch') {
    const topicType = args.topic_type as string | null;
    const topicId = args.topic_id as number | null;
    const label = (args.label as string | null) ?? '';

    const topic = buildTopic(topicType, topicId);
    if (!topic) return { ok: false, error: 'watch requires topic_type and topic_id.' };

    const result = addWatch(db, chatId, topic, label);
    return result.ok
      ? { ok: true, watching: topic, label }
      : { ok: false, error: result.error };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}

function buildTopic(type: string | null, id: number | null): string | null {
  if (!type || !id) return null;
  return `${type}.${id}`;
}

// ---------------------------------------------------------------------------
// Remap tool-specific args to kill_intel unified args
// ---------------------------------------------------------------------------

function remapArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const action = args.action as string | undefined;

  switch (tool) {
    case 'kill_stats':
      return args;

    case 'kill_battles':
      return {
        ...args,
        action: action === 'detail' ? 'battle_detail' : 'battles',
        battle_id: action === 'detail' ? args.id : undefined,
      };

    case 'kill_entity':
      return args;

    case 'kill_lookup':
      return args;

    case 'kill_spatial':
      if (action === 'near_coordinates' && args.system_id != null) {
        return { ...args, id: args.system_id };
      }
      return args;

    case 'kill_prices':
      return args;

    default:
      return args;
  }
}
