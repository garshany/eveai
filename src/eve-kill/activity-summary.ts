import type { Db } from '../db/sqlite.js';
import {
  EVE_KILL_SEARCH_CACHE_MAX_AGE_SECONDS,
  searchKillmails,
} from './client.js';
import { isCanonicalIsoTimestamp } from './normalize.js';
import type {
  KillmailEntity,
  KillmailSearchRequest,
  NormalizedKillmail,
} from './types.js';

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OBSERVATIONS = 100;
const MAX_SEARCH_REQUESTS = 4;
const DEFAULT_EVIDENCE_LIMIT = 5;
const LIMITATION = 'Third-party public killboard observation; coverage may be incomplete.';
const ARGUMENT_KEYS = new Set(['scope', 'id', 'activity', 'from', 'to', 'evidence_limit']);

export type KillActivitySummaryScope = 'system' | 'character' | 'corporation' | 'alliance';
export type KillActivitySummaryActivity = 'kills' | 'losses' | 'all';

export type ValidatedKillActivitySummaryArgs = {
  scope: KillActivitySummaryScope;
  id: number;
  activity: KillActivitySummaryActivity;
  from: string;
  to: string;
  evidence_limit: number;
};

type Role = { attacker: boolean; victim: boolean };

export type KillActivitySummaryError = {
  ok: false;
  source: 'EVE-KILL';
  authoritative: false;
  error: string;
  status: number | null;
  blocked: false;
};

export async function executeKillActivitySummary(
  db: Db,
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = validateKillActivitySummaryArgs(rawArgs);
  if (!parsed.ok) return parsed.error;
  const args = parsed.data;

  try {
    const result = await searchKillmails(
      db,
      buildSearchRequest(args),
      { limit: MAX_OBSERVATIONS, maxRequests: MAX_SEARCH_REQUESTS },
    );
    if (!result.ok) return projectClientError(result.error, result.status);

    const byId = new Map<number, NormalizedKillmail>();
    for (const kill of result.data.kills) {
      if (!matchesRequestedScope(kill, args.scope, args.id)) {
        return facadeError('EVE-KILL returned an invalid response.');
      }
      if (kill.totalValue !== undefined && (!Number.isFinite(kill.totalValue) || kill.totalValue < 0)) {
        return facadeError('EVE-KILL returned an invalid response.');
      }
      byId.set(kill.killmailId, kill);
    }

    const observations = [...byId.values()].sort(compareKills).slice(0, MAX_OBSERVATIONS);
    const selected = observations.flatMap((kill) => {
      const role = roleFor(kill, args.scope, args.id);
      return activityMatches(args.activity, role) ? [{ kill, role }] : [];
    });

    let kills = 0;
    let losses = 0;
    let dualRole = 0;
    let npc = 0;
    let solo = 0;
    let valued = 0;
    let totalValueIsk = 0;
    for (const observation of selected) {
      if (args.scope === 'system') {
        kills += 1;
      } else {
        if (observation.role.attacker) kills += 1;
        if (observation.role.victim) losses += 1;
        if (observation.role.attacker && observation.role.victim) dualRole += 1;
      }
      if (observation.kill.isNpc === true) npc += 1;
      if (observation.kill.isSolo === true) solo += 1;
      if (observation.kill.totalValue !== undefined) {
        valued += 1;
        totalValueIsk += observation.kill.totalValue;
      }
    }

    const newestTime = selected[0]?.kill.killmailTime ?? null;
    const oldestTime = selected.at(-1)?.kill.killmailTime ?? null;
    return {
      ok: true,
      source: 'EVE-KILL',
      authoritative: false,
      limitation: LIMITATION,
      freshness: {
        retrieved_at: new Date().toISOString(),
        data_through: newestTime,
        cache_max_age_seconds: EVE_KILL_SEARCH_CACHE_MAX_AGE_SECONDS,
      },
      scope: args.scope,
      id: args.id,
      activity: args.activity,
      window: { from: args.from, to: args.to },
      coverage: {
        observed: selected.length,
        truncated: result.data.truncated || byId.size > MAX_OBSERVATIONS,
      },
      aggregates: {
        kills,
        losses,
        dual_role: dualRole,
        npc,
        solo,
        valued,
        total_value_isk: totalValueIsk,
        first_killmail_time: oldestTime,
        last_killmail_time: newestTime,
      },
      evidence_killmail_ids: selected
        .slice(0, args.evidence_limit)
        .map((observation) => observation.kill.killmailId),
    };
  } catch {
    return facadeError('EVE-KILL activity summary failed.');
  }
}

export function validateKillActivitySummaryArgs(
  args: Record<string, unknown>,
  options: { programmatic?: boolean } = {},
): { ok: true; data: ValidatedKillActivitySummaryArgs } | { ok: false; error: KillActivitySummaryError } {
  if (Object.keys(args).some((key) => !ARGUMENT_KEYS.has(key))) {
    return invalidArguments();
  }
  const scope = isScope(args.scope) ? args.scope : null;
  const activity = isActivity(args.activity) ? args.activity : null;
  const id = typeof args.id === 'number' && Number.isSafeInteger(args.id) && args.id > 0
    ? args.id
    : null;
  const from = canonicalUtc(args.from);
  const to = canonicalUtc(args.to);
  const evidenceLimit = args.evidence_limit === null
    ? DEFAULT_EVIDENCE_LIMIT
    : typeof args.evidence_limit === 'number'
      && Number.isSafeInteger(args.evidence_limit)
      && args.evidence_limit >= 1
      && args.evidence_limit <= 10
      ? args.evidence_limit
      : null;

  if (!scope || !activity || id === null || !from || !to || evidenceLimit === null) {
    return invalidArguments();
  }
  if (options.programmatic && evidenceLimit > DEFAULT_EVIDENCE_LIMIT) {
    return invalidArguments();
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (fromMs >= toMs || toMs - fromMs > MAX_WINDOW_MS) {
    return {
      ok: false,
      error: facadeError('from/to must define a positive UTC window of at most seven days.'),
    };
  }
  if (scope === 'system' && activity !== 'all') {
    return {
      ok: false,
      error: facadeError('System scope requires activity=all.'),
    };
  }
  return {
    ok: true,
    data: { scope, id, activity, from, to, evidence_limit: evidenceLimit },
  };
}

function invalidArguments(): { ok: false; error: KillActivitySummaryError } {
  return {
    ok: false,
    error: facadeError('Invalid kill_activity_summary arguments.'),
  };
}

function canonicalUtc(value: unknown): string | null {
  if (typeof value !== 'string' || !value.endsWith('Z') || !isCanonicalIsoTimestamp(value)) return null;
  return new Date(Date.parse(value)).toISOString();
}

function isScope(value: unknown): value is KillActivitySummaryScope {
  return value === 'system' || value === 'character' || value === 'corporation' || value === 'alliance';
}

function isActivity(value: unknown): value is KillActivitySummaryActivity {
  return value === 'kills' || value === 'losses' || value === 'all';
}

function buildSearchRequest(args: ValidatedKillActivitySummaryArgs): KillmailSearchRequest {
  const request: KillmailSearchRequest = { from: args.from, to: args.to };
  if (args.scope === 'system') request.system_ids = [args.id];
  else if (args.scope === 'character') request.character_ids = [args.id];
  else if (args.scope === 'corporation') request.corporation_ids = [args.id];
  else request.alliance_ids = [args.id];
  return request;
}

function matchesRequestedScope(kill: NormalizedKillmail, scope: KillActivitySummaryScope, id: number): boolean {
  if (scope === 'system') return kill.solarSystemId === id;
  return roleFor(kill, scope, id).attacker || roleFor(kill, scope, id).victim;
}

function roleFor(kill: NormalizedKillmail, scope: KillActivitySummaryScope, id: number): Role {
  if (scope === 'system') return { attacker: false, victim: false };
  return {
    attacker: kill.attackers.some((entity) => entityMatches(entity, scope, id)),
    victim: entityMatches(kill.victim, scope, id),
  };
}

function entityMatches(
  entity: KillmailEntity,
  scope: Exclude<KillActivitySummaryScope, 'system'>,
  id: number,
): boolean {
  if (scope === 'character') return entity.characterId === id;
  if (scope === 'corporation') return entity.corporationId === id;
  return entity.allianceId === id;
}

function activityMatches(activity: KillActivitySummaryActivity, role: Role): boolean {
  if (activity === 'kills') return role.attacker;
  if (activity === 'losses') return role.victim;
  return true;
}

function compareKills(left: NormalizedKillmail, right: NormalizedKillmail): number {
  const timeDifference = Date.parse(right.killmailTime ?? '') - Date.parse(left.killmailTime ?? '');
  if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
  return right.killmailId - left.killmailId;
}

function projectClientError(error: string, status?: number): KillActivitySummaryError {
  if (status !== undefined) {
    return facadeError(`EVE-KILL request failed with HTTP status ${status}.`, status);
  }
  if (error.startsWith('EVE-KILL invalid response:')) {
    return facadeError('EVE-KILL returned an invalid response.');
  }
  return facadeError('EVE-KILL is temporarily unavailable.');
}

function facadeError(error: string, status: number | null = null): KillActivitySummaryError {
  return {
    ok: false,
    source: 'EVE-KILL',
    authoritative: false,
    error,
    status,
    blocked: false,
  };
}
