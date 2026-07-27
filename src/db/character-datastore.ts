import type { Db } from './sqlite.js';

/**
 * Tables of the materialized private character profile. Every one carries a
 * character_id column; the character_sql tool exposes them only through
 * per-query isolation views, and this list is the single source of truth for
 * lifecycle deletion (unlink, purge, ownership change).
 */
export const CHARACTER_DATA_TABLES = Object.freeze([
  'character_assets',
  'character_wallet',
  'character_wallet_journal',
  'character_orders',
  'character_contracts',
  'character_skills',
  'character_skillqueue',
  'character_clones',
  'character_standings',
  'character_presence',
  'character_profile',
  'character_sync_state',
]);

/** Removes every materialized private-data row of a character. */
export function deleteCharacterData(db: Db, characterId: number): void {
  for (const table of CHARACTER_DATA_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE character_id = ?`).run(characterId);
  }
}
