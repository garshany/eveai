/**
 * Thera/Turnur wormhole shortcut finder for route planning.
 *
 * Uses EVE-Scout's /v2/public/routes API for WH-aware routing
 * instead of manual brute-force ESI route calculations.
 * One API call replaces ~60 ESI requests.
 */

import type { Db } from '../db/sqlite.js';
import { getRoute, getSignatures } from './eve-scout-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TheraShortcut = {
  hub_system: string;
  hub_system_id: number;
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
// Constants
// ---------------------------------------------------------------------------

const MIN_SAVED_JUMPS = 3;
const THERA_SYSTEM_ID = 31000005;
const TURNUR_SYSTEM_ID = 30002086;
const HUB_IDS = new Set([THERA_SYSTEM_ID, TURNUR_SYSTEM_ID]);

// ---------------------------------------------------------------------------
// Shortcut finder
// ---------------------------------------------------------------------------

/**
 * Find the best WH shortcut via Thera or Turnur using EVE-Scout's
 * WH-aware route planner. Single API call replaces O(N) ESI calls.
 */
export async function findBestTheraShortcut(
  db: Db,
  originId: number,
  destinationId: number,
  directJumps: number,
  originName?: string,
  destinationName?: string,
): Promise<TheraShortcut | null> {
  // Resolve names from SDE if not provided
  const fromName = originName ?? resolveSystemName(db, originId);
  const toName = destinationName ?? resolveSystemName(db, destinationId);
  if (!fromName || !toName) return null;

  // Single EVE-Scout call — returns WH-aware route
  const result = await getRoute(db, fromName, toName, 'shortest');
  if (!result.ok || result.data.length === 0) return null;

  const route = result.data[0];
  const saved = directJumps - route.jumps;
  if (saved < MIN_SAVED_JUMPS) return null;

  // Check if route goes through a WH hub (Thera/Turnur)
  const hubIndex = route.route.findIndex((s) => HUB_IDS.has(s.system_id));
  if (hubIndex < 0) return null; // No WH shortcut used

  // Extract entry (system before hub) and exit (system after hub)
  const entrySystem = hubIndex > 0 ? route.route[hubIndex - 1] : null;
  const hubSystem = route.route[hubIndex];
  const exitSystem = hubIndex < route.route.length - 1 ? route.route[hubIndex + 1] : null;
  if (!entrySystem || !hubSystem || !exitSystem) return null;

  // Calculate jump segments
  const entryJumps = hubIndex - 1; // jumps from origin to entry system
  const exitJumps = route.route.length - hubIndex - 2; // jumps from exit system to destination

  // Enrich with WH metadata from signatures endpoint
  const whMeta = await enrichWithSignatures(db, entrySystem.system_id, exitSystem.system_id);

  return {
    hub_system: hubSystem.system_name,
    hub_system_id: hubSystem.system_id,
    entry_system: entrySystem.system_name,
    entry_system_id: entrySystem.system_id,
    entry_class: entrySystem.system_class,
    entry_region: entrySystem.region_name,
    entry_jumps: entryJumps,
    exit_system: exitSystem.system_name,
    exit_system_id: exitSystem.system_id,
    exit_class: exitSystem.system_class,
    exit_region: exitSystem.region_name,
    exit_jumps: exitJumps,
    total_jumps: route.jumps,
    direct_jumps: directJumps,
    saved_jumps: saved,
    max_ship_size: whMeta.maxShipSize,
    entry_remaining_hours: whMeta.entryHours,
    exit_remaining_hours: whMeta.exitHours,
    entry_wh_type: whMeta.entryWhType,
    exit_wh_type: whMeta.exitWhType,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSystemName(db: Db, systemId: number): string | null {
  const row = db.prepare('SELECT name FROM sde_systems WHERE system_id = ?').get(systemId) as { name: string } | undefined;
  return row?.name ?? null;
}

type WhMeta = {
  maxShipSize: string;
  entryHours: number;
  exitHours: number;
  entryWhType: string;
  exitWhType: string;
};

async function enrichWithSignatures(
  db: Db,
  entrySystemId: number,
  exitSystemId: number,
): Promise<WhMeta> {
  const defaults: WhMeta = {
    maxShipSize: 'unknown',
    entryHours: 0,
    exitHours: 0,
    entryWhType: 'unknown',
    exitWhType: 'unknown',
  };

  try {
    const result = await getSignatures(db);
    if (!result.ok) return defaults;

    const active = result.data.filter((s) => s.completed && s.remaining_hours >= 0);
    const entrySig = active.find((s) => s.in_system_id === entrySystemId);
    const exitSig = active.find((s) => s.in_system_id === exitSystemId);

    return {
      maxShipSize: smallerShipSize(
        entrySig?.max_ship_size ?? 'unknown',
        exitSig?.max_ship_size ?? 'unknown',
      ),
      entryHours: entrySig?.remaining_hours ?? 0,
      exitHours: exitSig?.remaining_hours ?? 0,
      entryWhType: entrySig?.wh_type ?? 'unknown',
      exitWhType: exitSig?.wh_type ?? 'unknown',
    };
  } catch {
    return defaults;
  }
}

const SHIP_SIZE_ORDER: Record<string, number> = { small: 1, medium: 2, large: 3, xlarge: 4 };

function smallerShipSize(a: string, b: string): string {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return (SHIP_SIZE_ORDER[a] ?? 0) <= (SHIP_SIZE_ORDER[b] ?? 0) ? a : b;
}
