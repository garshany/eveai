/**
 * EVE-KILL tool call router.
 * Dispatches tool name → handler, returns JSON-serializable result.
 */

import type { Db } from '../db/sqlite.js';
import type { EveKillToolName } from './tools.js';
import { executeKillFeed } from './feed.js';
import { executeKillQuery } from './kill-query.js';
import { executeKillIntel } from './intel.js';

export async function executeEveKillTool(
  db: Db,
  name: EveKillToolName,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'kill_feed':
      return await executeKillFeed(db, args) as unknown as Record<string, unknown>;
    case 'kill_query':
      return await executeKillQuery(db, args) as unknown as Record<string, unknown>;
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

/**
 * Remap tool-specific args to kill_intel unified args.
 * Each tool has its own param names; intel.ts dispatch uses 'action' field.
 */
function remapArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const action = args.action as string | undefined;

  switch (tool) {
    case 'kill_stats':
      // action is already stats/shortstats/top/global_stats
      return args;

    case 'kill_battles':
      // list → battles, detail → battle_detail
      return {
        ...args,
        action: action === 'detail' ? 'battle_detail' : 'battles',
        battle_id: action === 'detail' ? args.id : undefined,
      };

    case 'kill_entity':
      // action is already entity_detail/corp_history/etc.
      return args;

    case 'kill_lookup':
      // action is already killmail/killmail_batch/search/war/etc.
      return args;

    case 'kill_spatial':
      // near_celestial/near_coordinates — map system_id to id for intel
      if (action === 'near_coordinates' && args.system_id != null) {
        return { ...args, id: args.system_id };
      }
      return args;

    case 'kill_prices':
      // build_price/type_prices — already correct
      return args;

    default:
      return args;
  }
}
