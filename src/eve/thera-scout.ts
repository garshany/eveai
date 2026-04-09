/**
 * EVE-Scout Thera wormhole connection client.
 *
 * Fetches current Thera connections from EVE-Scout public API,
 * caches for 5 minutes, and finds optimal shortcuts for route planning.
 */

import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from './esi-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EveScoutSignature = {
  id: string;
  completed: boolean;
  wh_type: string;
  max_ship_size: string;
  expires_at: string;
  remaining_hours: number;
  in_system_id: number;
  in_system_name: string;
  in_system_class: string;
  in_region_name: string;
  out_system_id: number;
  out_system_name: string;
  in_signature: string;
  out_signature: string;
};

export type TheraShortcut = {
  entry_system: string;
  entry_system_id: number;
  entry_class: string;
  entry_region: string;
  entry_jumps: number;
  exit_system: string;
  exit_system_id: number;
  exit_class: string;
  exit_region: string;
  exit_jumps: number;
  total_jumps: number;
  direct_jumps: number;
  saved_jumps: number;
  max_ship_size: string;
  entry_remaining_hours: number;
  exit_remaining_hours: number;
  entry_wh_type: string;
  exit_wh_type: string;
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60_000;
let cachedConnections: EveScoutSignature[] | null = null;
let cacheTimestamp = 0;

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const EVE_SCOUT_URL = 'https://api.eve-scout.com/v2/public/signatures';
const EVE_SCOUT_TIMEOUT_MS = 8_000;

async function fetchTheraConnections(): Promise<EveScoutSignature[]> {
  if (cachedConnections && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedConnections;
  }

  try {
    const res = await fetch(EVE_SCOUT_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'eveai-bot/1.0 (Telegram)' },
      signal: AbortSignal.timeout(EVE_SCOUT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.log('[thera] EVE-Scout API error: %d', res.status);
      return cachedConnections ?? [];
    }
    const data = await res.json() as unknown;
    if (!Array.isArray(data)) return cachedConnections ?? [];

    const connections = data.filter(
      (item: unknown): item is EveScoutSignature =>
        !!item && typeof item === 'object'
        && typeof (item as Record<string, unknown>).in_system_id === 'number'
        && typeof (item as Record<string, unknown>).out_system_name === 'string',
    );

    cachedConnections = connections;
    cacheTimestamp = Date.now();
    console.log('[thera] fetched %d connections from EVE-Scout', connections.length);
    return connections;
  } catch (err) {
    console.log('[thera] EVE-Scout fetch failed: %s', err instanceof Error ? err.message : String(err));
    return cachedConnections ?? [];
  }
}

// ---------------------------------------------------------------------------
// Shortcut finder
// ---------------------------------------------------------------------------

const MIN_SAVED_JUMPS = 3;
const ROUTE_CONCURRENCY = 10;

async function fetchRouteLength(db: Db, from: number, to: number): Promise<number> {
  if (from === to) return 0;
  try {
    const result = await callEsiOperation<number[]>(
      db, 'get_route_origin_destination',
      { origin: from, destination: to, flag: 'shortest' },
    );
    if (result.ok && Array.isArray(result.data)) {
      return Math.max(result.data.length - 1, 0);
    }
  } catch { /* unreachable system or error */ }
  return -1;
}

export async function findBestTheraShortcut(
  db: Db,
  originId: number,
  destinationId: number,
  directJumps: number,
): Promise<TheraShortcut | null> {
  const connections = await fetchTheraConnections();
  const active = connections.filter((c) =>
    c.completed
    && c.remaining_hours >= 0
    && new Date(c.expires_at).getTime() > Date.now(),
  );

  if (active.length < 2) return null; // Need at least entry + exit

  // Calculate distances in parallel: origin→each exit, each exit→destination
  type DistEntry = { conn: EveScoutSignature; toOrigin: number; toDest: number };
  const distances: DistEntry[] = [];

  let idx = 0;
  const calcNext = async (): Promise<void> => {
    while (idx < active.length) {
      const conn = active[idx++];
      const [toOrigin, toDest] = await Promise.all([
        fetchRouteLength(db, originId, conn.in_system_id),
        fetchRouteLength(db, conn.in_system_id, destinationId),
      ]);
      distances.push({ conn, toOrigin, toDest });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(ROUTE_CONCURRENCY, active.length) }, () => calcNext()),
  );

  // Find best entry (closest to origin) and best exit (closest to destination)
  const validEntries = distances.filter((d) => d.toOrigin >= 0).sort((a, b) => a.toOrigin - b.toOrigin);
  const validExits = distances.filter((d) => d.toDest >= 0).sort((a, b) => a.toDest - b.toDest);

  let best: { entry: DistEntry; exit: DistEntry; total: number } | null = null;

  // Check top 5 entries × top 5 exits
  for (const entry of validEntries.slice(0, 5)) {
    for (const exit of validExits.slice(0, 5)) {
      if (entry.conn.id === exit.conn.id) continue; // Must use different holes
      const total = entry.toOrigin + exit.toDest + 1; // +1 for Thera transit
      if (!best || total < best.total) {
        best = { entry, exit, total };
      }
    }
  }

  if (!best) return null;

  const saved = directJumps - best.total;
  if (saved < MIN_SAVED_JUMPS) return null;

  return {
    entry_system: best.entry.conn.in_system_name,
    entry_system_id: best.entry.conn.in_system_id,
    entry_class: best.entry.conn.in_system_class,
    entry_region: best.entry.conn.in_region_name,
    entry_jumps: best.entry.toOrigin,
    exit_system: best.exit.conn.in_system_name,
    exit_system_id: best.exit.conn.in_system_id,
    exit_class: best.exit.conn.in_system_class,
    exit_region: best.exit.conn.in_region_name,
    exit_jumps: best.exit.toDest,
    total_jumps: best.total,
    direct_jumps: directJumps,
    saved_jumps: saved,
    max_ship_size: smallerShipSize(best.entry.conn.max_ship_size, best.exit.conn.max_ship_size),
    entry_remaining_hours: best.entry.conn.remaining_hours,
    exit_remaining_hours: best.exit.conn.remaining_hours,
    entry_wh_type: best.entry.conn.wh_type,
    exit_wh_type: best.exit.conn.wh_type,
  };
}

const SHIP_SIZE_ORDER: Record<string, number> = { small: 1, medium: 2, large: 3, xlarge: 4 };

function smallerShipSize(a: string, b: string): string {
  return (SHIP_SIZE_ORDER[a] ?? 0) <= (SHIP_SIZE_ORDER[b] ?? 0) ? a : b;
}
