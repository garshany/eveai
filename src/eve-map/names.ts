/**
 * Bulk name resolution for ids the killmail feed carries without names.
 *
 * `/universe/names/` is public, takes up to 1000 ids per call, and the mapping
 * never changes for a character, so a process-lifetime cache is enough. Bounded
 * on both ends: a capped batch, and a failure resolves to "no name" rather than
 * failing the panel that asked.
 */

import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from '../eve/esi-client.js';

const MAX_IDS_PER_CALL = 500;
/** Names are effectively immutable; the cap only bounds memory. */
const MAX_CACHED = 20_000;

const cache = new Map<number, string>();

export function resetNameCacheForTests(): void {
  cache.clear();
}

export async function resolveCharacterNames(db: Db, ids: number[]): Promise<Map<number, string>> {
  const resolved = new Map<number, string>();
  const missing: number[] = [];
  for (const id of ids) {
    const cached = cache.get(id);
    if (cached) resolved.set(id, cached);
    else if (Number.isSafeInteger(id) && id > 0) missing.push(id);
  }
  if (missing.length === 0) return resolved;

  try {
    const response = await callEsiOperation<unknown>(
      db,
      'post_universe_names',
      { ids: JSON.stringify(missing.slice(0, MAX_IDS_PER_CALL)) },
      null,
    );
    if (!response.ok || !Array.isArray(response.data)) return resolved;
    for (const entry of response.data) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== 'number' || typeof record.name !== 'string') continue;
      resolved.set(record.id, record.name);
      if (cache.size < MAX_CACHED) cache.set(record.id, record.name);
    }
  } catch {
    // A panel with ids and no names is still better than no panel.
  }
  return resolved;
}
