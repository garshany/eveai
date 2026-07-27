import type { Db } from '../../db/sqlite.js';
import type { UserContext } from '../../auth/user-resolver.js';
import type { EsiExecutionGuard } from '../../eve/esi-client.js';
import {
  datasetsForTables,
  ensureCharacterDatasetsFresh,
  type CharacterDatasetStatus,
} from '../../eve/character-sync.js';
import { getLinkedCharacter } from '../../eve/sso.js';
import { analyzeCharacterSqlTables, executeCharacterSql } from './character-execution.js';

/**
 * Orchestrates one character_sql call: resolve the active character from the
 * server-side session (never from tool args), validate the SQL, lazily
 * refresh only the ESI datasets backing the referenced tables, then execute
 * row-scoped. Freshness is reported so the model can cite data age and
 * degrade honestly (no_scope/error datasets keep serving stale or empty sets).
 */
export async function runCharacterSqlTool(
  db: Db,
  ctx: UserContext,
  sql: string,
  guard: EsiExecutionGuard = {},
): Promise<unknown> {
  const linked = getLinkedCharacter(db, ctx);
  if (!linked) {
    return {
      ok: false,
      rows: [],
      count: 0,
      error: 'No linked EVE character: character profile data is unavailable.',
    };
  }

  const analysis = analyzeCharacterSqlTables(db, sql);
  if (!analysis.ok) {
    return { ok: false, rows: [], count: 0, error: analysis.error };
  }

  const datasets = datasetsForTables(analysis.characterTables);
  const statuses = await ensureCharacterDatasetsFresh(db, ctx, datasets, guard);

  if (guard.signal?.aborted || guard.identityCurrent?.() === false) {
    return { ok: false, blocked: true, error: 'Turn identity changed or request was cancelled during profile sync' };
  }

  const result = executeCharacterSql(db, sql, linked.characterId);
  return {
    ...result,
    data_status: statuses.map(slimStatus),
  };
}

function slimStatus(status: CharacterDatasetStatus): Record<string, unknown> {
  return {
    dataset: status.dataset,
    status: status.status,
    synced_at: status.synced_at,
    ...(status.error ? { error: status.error } : {}),
  };
}
