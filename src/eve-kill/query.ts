/**
 * Query builder helpers for EVE-KILL /api/query (MongoDB-style).
 */

import type { QueryFilter, QueryRequest, KillFeedScope, ActivityFilter } from './types.js';

// ---------------------------------------------------------------------------
// Feed query builder — translates kill_feed params into Query API requests
// ---------------------------------------------------------------------------

export function buildFeedQuery(
  scope: KillFeedScope,
  id: number,
  activity: ActivityFilter,
  pastSeconds: number,
  limit: number,
): QueryRequest {
  const sinceTs = Math.floor(Date.now() / 1000) - pastSeconds;
  const filter: QueryFilter = {
    kill_time: { $gte: sinceTs },
  };

  const scopeFilter = buildScopeFilter(scope, id, activity);
  Object.assign(filter, scopeFilter);

  return {
    filter,
    options: {
      limit,
      sort: { kill_time: -1 },
    },
  };
}

function buildScopeFilter(scope: KillFeedScope, id: number, activity: ActivityFilter): QueryFilter {
  switch (scope) {
    case 'system':
      return { system_id: id };

    case 'character':
      return activityFilter('character_id', id, activity);

    case 'corporation':
      return activityFilter('corporation_id', id, activity);

    case 'alliance':
      return activityFilter('alliance_id', id, activity);

    case 'ship_type':
      // For ship_type, search both victim and attacker ship
      return { 'victim.ship_type_id': id };
  }
}

function activityFilter(field: string, id: number, activity: ActivityFilter): QueryFilter {
  if (activity === 'kills') {
    return { [`attackers.${field}`]: id };
  }
  if (activity === 'losses') {
    return { [`victim.${field}`]: id };
  }
  // 'all' — either victim or attacker
  return {
    $or: [
      { [`victim.${field}`]: id },
      { [`attackers.${field}`]: id },
    ],
  };
}

// ---------------------------------------------------------------------------
// User query sanitization — cap limits, validate operators
// ---------------------------------------------------------------------------

const ALLOWED_OPERATORS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte',
  '$in', '$nin', '$exists', '$regex',
  '$and', '$or',
]);

export function sanitizeUserFilter(filter: unknown): QueryFilter {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    return {};
  }
  return walkFilter(filter as Record<string, unknown>);
}

function walkFilter(obj: Record<string, unknown>): QueryFilter {
  const result: QueryFilter = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('$')) {
      if (!ALLOWED_OPERATORS.has(key)) continue;
      if ((key === '$and' || key === '$or') && Array.isArray(value)) {
        result[key] = value
          .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v))
          .map(walkFilter);
        continue;
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = walkFilter(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
