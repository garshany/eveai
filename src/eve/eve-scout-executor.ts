/**
 * EVE-Scout tool call router.
 * Dispatches tool name -> handler, returns JSON-serializable result.
 */

import type { Db } from '../db/sqlite.js';
import type { EveScoutToolName } from './eve-scout-tools.js';
import {
  getRoute,
  getMultiRoute,
  getClosestHighsec,
  getJoveRoutes,
  getSignatureRoutes,
  getSignatures,
  getObservations,
  getWormholeTypes,
  searchSystems,
} from './eve-scout-client.js';

export async function executeEveScoutTool(
  db: Db,
  name: EveScoutToolName,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'scout_route':
      return await executeScoutRoute(db, args);
    case 'scout_signatures':
      return await executeScoutSignatures(db, args);
    case 'scout_observations':
      return await executeScoutObservations(db);
    case 'scout_wormhole_types':
      return await executeScoutWormholeTypes(db, args);
    case 'scout_systems':
      return await executeScoutSystems(db, args);
  }
}

// ---------------------------------------------------------------------------
// scout_route
// ---------------------------------------------------------------------------

async function executeScoutRoute(
  db: Db,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const from = String(args.from ?? '');
  if (!from) return { ok: false, error: 'Missing required parameter: from' };

  const mode = String(args.mode ?? 'route');
  const preference = args.preference ? String(args.preference) : undefined;

  switch (mode) {
    case 'highsec': {
      const result = await getClosestHighsec(db, from);
      if (!result.ok) return result;
      return { ok: true, routes: result.data.map(compactRoute) };
    }
    case 'jove': {
      const result = await getJoveRoutes(db, from, preference);
      if (!result.ok) return result;
      return { ok: true, routes: result.data.map(compactRoute) };
    }
    case 'signatures': {
      const result = await getSignatureRoutes(db, from, preference);
      if (!result.ok) return result;
      return { ok: true, count: result.data.length, routes: result.data.map(compactRoute) };
    }
    default: {
      // mode=route — single or multi-target
      const destinations = Array.isArray(args.destinations)
        ? args.destinations.filter((d): d is string => typeof d === 'string')
        : [];
      const to = args.to ? String(args.to) : null;

      if (destinations.length > 0) {
        const result = await getMultiRoute(db, from, destinations, preference);
        if (!result.ok) return result;
        return { ok: true, routes: result.data.map(compactRoute) };
      }

      if (!to) return { ok: false, error: 'mode=route requires "to" or "destinations"' };

      const result = await getRoute(db, from, to, preference);
      if (!result.ok) return result;
      return { ok: true, routes: result.data.map(compactRoute) };
    }
  }
}

/** Compact route for model consumption — keep essential fields only. */
function compactRoute(route: { from: string; to: string; jumps: number; signature_id?: number; route: Array<Record<string, unknown>> }) {
  return {
    from: route.from,
    to: route.to,
    jumps: route.jumps,
    signature_id: route.signature_id ?? null,
    systems: route.route.map((s) => ({
      name: s.system_name,
      class: s.system_class,
      sec: s.security_status,
      region: s.region_name,
      ...(s.jove_observatory ? { jove: true } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// scout_signatures
// ---------------------------------------------------------------------------

async function executeScoutSignatures(
  db: Db,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await getSignatures(db);
  if (!result.ok) return result;

  let sigs = result.data.filter((s) => s.completed);
  const systemName = args.system_name ? String(args.system_name) : null;
  if (systemName) {
    const lower = systemName.toLowerCase();
    sigs = sigs.filter((s) =>
      s.in_system_name.toLowerCase() === lower
      || s.out_system_name.toLowerCase() === lower,
    );
  }

  return {
    ok: true,
    count: sigs.length,
    connections: sigs.map((s) => ({
      id: s.id,
      hub: s.out_system_name,
      hub_sig: s.out_signature,
      exit_system: s.in_system_name,
      exit_system_id: s.in_system_id,
      exit_class: s.in_system_class,
      exit_region: s.in_region_name,
      exit_sig: s.in_signature,
      wh_type: s.wh_type,
      max_ship_size: s.max_ship_size,
      remaining_hours: s.remaining_hours,
      expires_at: s.expires_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// scout_observations
// ---------------------------------------------------------------------------

async function executeScoutObservations(
  db: Db,
): Promise<Record<string, unknown>> {
  const result = await getObservations(db);
  if (!result.ok) return result;

  return {
    ok: true,
    count: result.data.length,
    observations: result.data.map((o) => ({
      type: o.observation_type,
      category: o.observation_category,
      name: o.display_name,
      system: o.system_name,
      system_id: o.system_id,
      region: o.region_name,
      hours_active: o.hours_in_system,
      observed_in_person: o.observed_in_person,
    })),
  };
}

// ---------------------------------------------------------------------------
// scout_wormhole_types
// ---------------------------------------------------------------------------

async function executeScoutWormholeTypes(
  db: Db,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const filters: { identifier?: string; source?: string; target?: string } = {};
  if (args.identifier) filters.identifier = String(args.identifier);
  if (args.source) filters.source = String(args.source);
  if (args.target) filters.target = String(args.target);

  const result = await getWormholeTypes(db, Object.keys(filters).length > 0 ? filters : undefined);
  if (!result.ok) return result;

  return {
    ok: true,
    count: result.data.length,
    wormhole_types: result.data.map((wh) => ({
      identifier: wh.identifier,
      type_id: wh.type_id,
      max_jump_mass: wh.max_jump_mass,
      max_stable_mass: wh.max_stable_mass,
      lifetime_minutes: wh.max_stable_time,
      mass_regeneration: wh.mass_regeneration,
      source_classes: wh.source,
      target_class: wh.target_system_class,
      possible_static: wh.possible_static,
      wandering_only: wh.wandering_only,
      ...(wh.comment_public ? { comment: wh.comment_public } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// scout_systems
// ---------------------------------------------------------------------------

async function executeScoutSystems(
  db: Db,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const query = String(args.query ?? '');
  if (!query) return { ok: false, error: 'Missing required parameter: query' };

  const space = args.space ? String(args.space) : undefined;
  const limit = typeof args.limit === 'number' ? Math.min(25, Math.max(1, args.limit)) : undefined;

  const result = await searchSystems(db, query, space, limit);
  if (!result.ok) return result;

  return {
    ok: true,
    count: result.data.length,
    systems: result.data.map((s) => ({
      name: s.system_name,
      id: s.system_id,
      class: s.system_class,
      sec: s.security_status,
      region: s.region_name,
      ...(s.jove_observatory ? { jove: true } : {}),
    })),
  };
}
