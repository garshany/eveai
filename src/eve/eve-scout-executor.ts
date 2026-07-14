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

const EVE_SCOUT_SOURCE = 'EVE-Scout' as const;
const EVE_SCOUT_CACHE_MAX_AGE_SECONDS = 86400;
const MAX_TOOL_OUTPUT_CHARS = 12_000;
export const SCOUT_SYSTEMS_CANDIDATE_CAP = 250;
const SCOUT_SYSTEM_CLASSES = [
  'hs', 'ls', 'ns', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c12', 'c13',
] as const;

export type ScoutSystemClass = typeof SCOUT_SYSTEM_CLASSES[number];
export type CompareWormholeTypesArgs = { identifiers: string[] };
export type ScoutSystemsArgs = { query: string; space: ScoutSystemClass | null; limit: number };
export type EveScoutArgsValidation<T> =
  | { ok: true; args: T }
  | { ok: false; error: string };

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
    case 'compare_wormhole_types':
      return await executeCompareWormholeTypes(db, args);
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
// compare_wormhole_types
// ---------------------------------------------------------------------------

export function validateCompareWormholeTypesArgs(
  value: Record<string, unknown>,
): EveScoutArgsValidation<CompareWormholeTypesArgs> {
  if (!hasOnlyKeys(value, ['identifiers'])) {
    return { ok: false, error: 'compare_wormhole_types accepts only identifiers' };
  }
  if (!Array.isArray(value.identifiers) || value.identifiers.length < 2 || value.identifiers.length > 8) {
    return { ok: false, error: 'identifiers must contain between 2 and 8 values' };
  }
  const identifiers: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.identifiers) {
    if (typeof raw !== 'string') return { ok: false, error: 'identifiers must contain only strings' };
    const identifier = raw.trim().toUpperCase();
    if (!/^[A-Z][0-9]{3}$/.test(identifier)) {
      return { ok: false, error: 'Each identifier must match one letter followed by three digits' };
    }
    if (seen.has(identifier)) return { ok: false, error: 'identifiers must be unique' };
    seen.add(identifier);
    identifiers.push(identifier);
  }
  return { ok: true, args: { identifiers } };
}

async function executeCompareWormholeTypes(
  db: Db,
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const validated = validateCompareWormholeTypesArgs(rawArgs);
  if (!validated.ok) return scoutError(validated.error);

  try {
    const result = await getWormholeTypes(db);
    if (!result.ok) return scoutClientError(result.status ?? null);
    const byIdentifier = new Map(result.data.map((entry) => [entry.identifier.toUpperCase(), entry]));
    const output = {
      ok: true,
      source: EVE_SCOUT_SOURCE,
      authoritative: false,
      limitation: 'Third-party public EVE-Scout data; entries may be stale or incomplete.',
      freshness: {
        retrieved_at: new Date().toISOString(),
        data_through: result.freshness.dataThrough,
        cache_max_age_seconds: EVE_SCOUT_CACHE_MAX_AGE_SECONDS,
      },
      wormhole_types: validated.args.identifiers.map((identifier) => {
        const entry = byIdentifier.get(identifier);
        return entry ? {
          identifier,
          found: true,
          type_id: entry.type_id,
          max_jump_mass: entry.max_jump_mass,
          max_stable_mass: entry.max_stable_mass,
          lifetime_minutes: entry.max_stable_time,
          mass_regeneration: entry.mass_regeneration,
          source_classes: entry.source,
          target_class: entry.target_system_class,
          possible_static: entry.possible_static,
          wandering_only: entry.wandering_only,
        } : {
          identifier,
          found: false,
          type_id: null,
          max_jump_mass: null,
          max_stable_mass: null,
          lifetime_minutes: null,
          mass_regeneration: null,
          source_classes: [],
          target_class: null,
          possible_static: null,
          wandering_only: null,
        };
      }),
    };
    return boundedScoutOutput(output);
  } catch {
    return scoutError('EVE-Scout request failed');
  }
}

// ---------------------------------------------------------------------------
// scout_systems
// ---------------------------------------------------------------------------

export function validateScoutSystemsArgs(
  value: Record<string, unknown>,
  options: { programmatic?: boolean } = {},
): EveScoutArgsValidation<ScoutSystemsArgs> {
  if (!hasOnlyKeys(value, ['query', 'space', 'limit'])) {
    return { ok: false, error: 'scout_systems accepts only query, space, and limit' };
  }
  if (typeof value.query !== 'string') return { ok: false, error: 'query must be a string' };
  const query = value.query.trim();
  if (query.length < 1 || query.length > 64) {
    return { ok: false, error: 'query length must be between 1 and 64 characters' };
  }
  if (value.space !== null && !isScoutSystemClass(value.space)) {
    return { ok: false, error: 'space is not a supported system class' };
  }
  const limit = value.limit === null ? 10 : value.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 25) {
    return { ok: false, error: 'limit must be null or an integer between 1 and 25' };
  }
  if (options.programmatic && (limit as number) > 10) {
    return { ok: false, error: 'Programmatic scout_systems limit cannot exceed 10' };
  }
  return { ok: true, args: { query, space: value.space as ScoutSystemClass | null, limit: limit as number } };
}

async function executeScoutSystems(
  db: Db,
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const validated = validateScoutSystemsArgs(rawArgs);
  if (!validated.ok) return scoutError(validated.error);
  const { query, space, limit } = validated.args;
  const upstreamSpace = toUpstreamSpace(space);
  const candidateLimit = space === null
    ? limit
    : Math.min(SCOUT_SYSTEMS_CANDIDATE_CAP, Math.max(25, limit * 10));

  try {
    const result = await searchSystems(db, query, upstreamSpace, candidateLimit);
    if (!result.ok) return scoutClientError(result.status ?? null);
    const systems = result.data
      .filter((system) => space === null || system.system_class === space)
      .slice(0, limit)
      .map((system) => ({
        system_id: system.system_id,
        system_name: system.system_name,
        system_class: system.system_class,
        security_status: system.security_status,
        region_id: system.region_id,
        region_name: system.region_name,
        jove_observatory: system.jove_observatory ?? false,
      }));
    return boundedScoutOutput({
      ok: true,
      source: EVE_SCOUT_SOURCE,
      authoritative: false,
      limitation: 'Third-party public EVE-Scout classification; results may be stale or incomplete.',
      freshness: {
        retrieved_at: new Date().toISOString(),
        data_through: result.freshness.dataThrough,
        cache_max_age_seconds: EVE_SCOUT_CACHE_MAX_AGE_SECONDS,
      },
      query,
      space,
      count: systems.length,
      systems,
    });
  } catch {
    return scoutError('EVE-Scout request failed');
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isScoutSystemClass(value: unknown): value is ScoutSystemClass {
  return typeof value === 'string' && (SCOUT_SYSTEM_CLASSES as readonly string[]).includes(value);
}

function toUpstreamSpace(space: ScoutSystemClass | null): 'k-space' | 'j-space' | undefined {
  if (space === null) return undefined;
  return space === 'hs' || space === 'ls' || space === 'ns' ? 'k-space' : 'j-space';
}

function scoutError(error: string, status: number | null = null, blocked = false): Record<string, unknown> {
  return { ok: false, source: EVE_SCOUT_SOURCE, authoritative: false, error, status, blocked };
}

function scoutClientError(status: number | null): Record<string, unknown> {
  return scoutError(status === null ? 'EVE-Scout request failed' : `EVE-Scout HTTP ${status}`, status);
}

function boundedScoutOutput(output: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(output).length <= MAX_TOOL_OUTPUT_CHARS) return output;
  return scoutError('EVE-Scout result exceeds the local output size limit');
}
