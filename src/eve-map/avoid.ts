/**
 * The pilot's standing avoid list.
 *
 * "Never route me through Uedama again" is a preference, not a parameter of one
 * request. It is stored per user and applied to every route this account plans
 * — from the map, from the chat agent, from a tool call — so the decision only
 * has to be made once.
 *
 * Bounded on purpose: an avoid list large enough to disconnect the graph turns
 * "no route found" into the normal answer, which reads as a broken planner.
 */

import type { Db } from '../db/sqlite.js';
import { getMapSystem } from '../eve/map-graph.js';

export type AvoidEntry = {
  systemId: number;
  name: string;
  security: number;
  regionName: string | null;
  note: string | null;
  createdAtMs: number;
};

/** Above this the graph starts fragmenting and every route becomes unroutable. */
export const MAX_AVOID_SYSTEMS = 200;

export function listAvoided(db: Db, userId: number): AvoidEntry[] {
  const rows = db.prepare(`
    SELECT system_id, note, created_at_ms FROM map_avoid_systems
    WHERE user_id = ? ORDER BY created_at_ms DESC
  `).all(userId) as Array<{ system_id: number; note: string | null; created_at_ms: number }>;

  return rows.map((row) => {
    const system = getMapSystem(db, row.system_id);
    return {
      systemId: row.system_id,
      name: system?.name ?? `System ${row.system_id}`,
      security: system?.security ?? 0,
      regionName: system?.regionName ?? null,
      note: row.note,
      createdAtMs: row.created_at_ms,
    };
  });
}

/** Just the ids, for the router. One indexed read per route. */
export function avoidSetFor(db: Db, userId: number): Set<number> {
  const rows = db.prepare('SELECT system_id FROM map_avoid_systems WHERE user_id = ?')
    .all(userId) as Array<{ system_id: number }>;
  return new Set(rows.map((row) => row.system_id));
}

export type AddResult =
  | { ok: true; entry: AvoidEntry; alreadyPresent: boolean }
  | { ok: false; error: string };

export function addAvoided(
  db: Db,
  userId: number,
  systemId: number,
  note: string | null = null,
  now = Date.now(),
): AddResult {
  const system = getMapSystem(db, systemId);
  if (!system) return { ok: false, error: `System ${systemId} is not in the map graph.` };

  const existing = db.prepare(
    'SELECT 1 FROM map_avoid_systems WHERE user_id = ? AND system_id = ?',
  ).get(userId, systemId);

  if (!existing) {
    const count = (db.prepare(
      'SELECT COUNT(*) AS n FROM map_avoid_systems WHERE user_id = ?',
    ).get(userId) as { n: number }).n;
    if (count >= MAX_AVOID_SYSTEMS) {
      return {
        ok: false,
        error: `Список «избегать» ограничен ${MAX_AVOID_SYSTEMS} системами — иначе маршрут перестаёт строиться вообще.`,
      };
    }
  }

  db.prepare(`
    INSERT INTO map_avoid_systems (user_id, system_id, note, created_at_ms)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, system_id) DO UPDATE SET note = COALESCE(excluded.note, note)
  `).run(userId, systemId, note, now);

  return {
    ok: true,
    alreadyPresent: Boolean(existing),
    entry: {
      systemId,
      name: system.name,
      security: system.security,
      regionName: system.regionName,
      note,
      createdAtMs: now,
    },
  };
}

export function removeAvoided(db: Db, userId: number, systemId: number): boolean {
  return db.prepare('DELETE FROM map_avoid_systems WHERE user_id = ? AND system_id = ?')
    .run(userId, systemId).changes > 0;
}

export function clearAvoided(db: Db, userId: number): number {
  return db.prepare('DELETE FROM map_avoid_systems WHERE user_id = ?').run(userId).changes;
}

/**
 * Merge the stored list with any ids supplied for this one request.
 *
 * The origin and destination are never removable this way: a pilot who avoided
 * a system and later chooses to fly *to* it should get a route, not a refusal
 * from a decision they made last week.
 */
export function effectiveAvoidSet(
  db: Db,
  userId: number,
  requestAvoid: Iterable<number> = [],
  keep: Iterable<number> = [],
): Set<number> {
  const set = avoidSetFor(db, userId);
  for (const id of requestAvoid) set.add(id);
  for (const id of keep) set.delete(id);
  return set;
}
