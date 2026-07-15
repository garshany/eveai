import type { NativeFunctionTool } from '../agent/native-responses.js';
import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from './esi-client.js';

const ARGUMENT_KEYS = new Set(['metric', 'system_ids']);
const MAX_OUTPUT_CHARS = 12_000;
const INDUSTRY_ACTIVITIES = [
  'manufacturing',
  'reaction',
  'invention',
  'copying',
  'researching_material_efficiency',
  'researching_time_efficiency',
] as const;

export type SystemMetric = 'kills' | 'jumps' | 'industry' | 'sovereignty';
export type SystemMetricSnapshotArgs = { metric: SystemMetric; system_ids: number[] };
export type SystemMetricSnapshotError = {
  ok: false;
  source: 'CCP ESI';
  authoritative: true;
  error: string;
  status: number | null;
  blocked: boolean;
};

const OPERATIONS: Record<SystemMetric, string> = {
  kills: 'get_universe_system_kills',
  jumps: 'get_universe_system_jumps',
  industry: 'get_industry_systems',
  sovereignty: 'get_sovereignty_map',
};

export const SYSTEM_METRIC_SNAPSHOT_TOOL: NativeFunctionTool = {
  type: 'function',
  name: 'system_metric_snapshot',
  description:
    'Project one fixed public ESI bulk system metric onto one to 100 exact system IDs. '
    + 'Returns one compact row per requested ID in caller order and never exposes the full bulk response.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      metric: { type: 'string', enum: ['kills', 'jumps', 'industry', 'sovereignty'] },
      system_ids: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    required: ['metric', 'system_ids'],
    additionalProperties: false,
  },
};

export function isSystemMetricSnapshotTool(name: string): boolean {
  return name === SYSTEM_METRIC_SNAPSHOT_TOOL.name;
}

export function validateSystemMetricSnapshotArgs(
  args: Record<string, unknown>,
  _options: { programmatic?: boolean } = {},
): { ok: true; data: SystemMetricSnapshotArgs } | { ok: false; error: SystemMetricSnapshotError } {
  if (!isPlainRecord(args) || Object.keys(args).length !== ARGUMENT_KEYS.size
    || Object.keys(args).some((key) => !ARGUMENT_KEYS.has(key))
    || !isSystemMetric(args.metric)
    || !Array.isArray(args.system_ids)
    || args.system_ids.length < 1
    || args.system_ids.length > 100
    || args.system_ids.some((id) => !isPositiveSafeInteger(id))
    || new Set(args.system_ids).size !== args.system_ids.length) {
    return invalidArguments();
  }
  return { ok: true, data: { metric: args.metric, system_ids: [...args.system_ids] as number[] } };
}

export async function executeSystemMetricSnapshot(
  db: Db,
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = validateSystemMetricSnapshotArgs(rawArgs);
  if (!parsed.ok) return parsed.error;
  const args = parsed.data;
  try {
    const response = await callEsiOperation(db, OPERATIONS[args.metric], {}, null);
    if (!response.ok) return esiFailure(response.status);
    const rows = projectRows(args, response.data);
    return safeResult({
      ok: true,
      source: 'CCP ESI',
      authoritative: true,
      freshness: {
        retrieved_at: new Date().toISOString(),
        data_through: headerTimestamp(response.headers['last-modified']),
        cache_max_age_seconds: cacheMaxAge(response.headers),
      },
      metric: args.metric,
      count: rows.length,
      rows,
    });
  } catch {
    return facadeError('CCP ESI returned an invalid system metric response.');
  }
}

function projectRows(args: SystemMetricSnapshotArgs, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('bulk response must be an array');
  if (value.length > 10_000) throw new Error('bulk response exceeds row limit');
  const requested = new Set(args.system_ids);
  const projected = new Map<number, Record<string, unknown>>();
  for (const item of value) {
    const row = record(item);
    const parsed = parseMetricRow(args.metric, row);
    if (!requested.has(parsed.systemId)) continue;
    if (projected.has(parsed.systemId)) throw new Error('duplicate requested system row');
    projected.set(parsed.systemId, parsed.output);
  }
  return args.system_ids.map((systemId) => projected.get(systemId) ?? missingRow(args.metric, systemId));
}

function parseMetricRow(
  metric: SystemMetric,
  row: Record<string, unknown>,
): { systemId: number; output: Record<string, unknown> } {
  if (metric === 'kills') {
    const systemId = positiveSafeInteger(row.system_id);
    return {
      systemId,
      output: {
        system_id: systemId,
        found: true,
        ship: nonNegativeSafeInteger(row.ship_kills),
        npc: nonNegativeSafeInteger(row.npc_kills),
        pod: nonNegativeSafeInteger(row.pod_kills),
      },
    };
  }
  if (metric === 'jumps') {
    const systemId = positiveSafeInteger(row.system_id);
    return {
      systemId,
      output: { system_id: systemId, found: true, jumps: nonNegativeSafeInteger(row.ship_jumps) },
    };
  }
  if (metric === 'industry') {
    const systemId = positiveSafeInteger(row.solar_system_id);
    if (!Array.isArray(row.cost_indices)) throw new Error('invalid cost indices');
    const relevant = new Map<string, number>();
    for (const value of row.cost_indices) {
      const entry = record(value);
      if (typeof entry.activity !== 'string' || entry.activity.length < 1 || entry.activity.length > 128) {
        throw new Error('invalid activity');
      }
      const cost = finiteNonNegative(entry.cost_index);
      if ((INDUSTRY_ACTIVITIES as readonly string[]).includes(entry.activity)) {
        if (relevant.has(entry.activity)) throw new Error('duplicate cost index');
        relevant.set(entry.activity, round(cost));
      }
    }
    return {
      systemId,
      output: {
        system_id: systemId,
        found: true,
        cost_indices: INDUSTRY_ACTIVITIES.map((activity) => relevant.get(activity) ?? null),
      },
    };
  }

  const systemId = positiveSafeInteger(row.system_id);
  const holders = [
    ['alliance', row.alliance_id],
    ['corporation', row.corporation_id],
    ['faction', row.faction_id],
  ] as const;
  const present = holders.filter(([, id]) => id !== undefined && id !== null);
  for (const [, id] of present) positiveSafeInteger(id);
  if (present.length > 1) throw new Error('conflicting sovereignty holders');
  return {
    systemId,
    output: {
      system_id: systemId,
      found: true,
      holder_type: present[0]?.[0] ?? 'none',
      holder_id: present.length === 1 ? positiveSafeInteger(present[0]![1]) : null,
    },
  };
}

function missingRow(metric: SystemMetric, systemId: number): Record<string, unknown> {
  if (metric === 'kills') return { system_id: systemId, found: false, ship: null, npc: null, pod: null };
  if (metric === 'jumps') return { system_id: systemId, found: false, jumps: null };
  if (metric === 'industry') {
    return { system_id: systemId, found: false, cost_indices: [null, null, null, null, null, null] };
  }
  return { system_id: systemId, found: false, holder_type: 'none', holder_id: null };
}

function headerTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function cacheMaxAge(headers: Record<string, string>): number | null {
  const match = /(?:^|,)\s*max-age=(\d+)\b/i.exec(headers['cache-control'] ?? '');
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function round(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
  if (!Number.isFinite(rounded)) throw new Error('non-finite result');
  return Object.is(rounded, -0) ? 0 : rounded;
}

function safeResult(value: Record<string, unknown>): Record<string, unknown> {
  try {
    assertJsonValue(value);
    if (JSON.stringify(value).length > MAX_OUTPUT_CHARS) {
      return facadeError('CCP ESI system metric summary exceeded the safe output limit.');
    }
    return value;
  } catch {
    return facadeError('CCP ESI returned an invalid system metric response.');
  }
}

function assertJsonValue(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry);
    return;
  }
  for (const entry of Object.values(record(value))) assertJsonValue(entry);
}

function invalidArguments(): { ok: false; error: SystemMetricSnapshotError } {
  return { ok: false, error: facadeError('Invalid system_metric_snapshot arguments.', null, true) };
}

function esiFailure(status: unknown): SystemMetricSnapshotError {
  const safeStatus = safeHttpStatus(status);
  return facadeError(
    safeStatus === null ? 'CCP ESI system metric request failed.' : `CCP ESI system metric request failed with HTTP status ${safeStatus}.`,
    safeStatus,
  );
}

function facadeError(
  error: string,
  status: number | null = null,
  blocked = false,
): SystemMetricSnapshotError {
  return { ok: false, source: 'CCP ESI', authoritative: true, error, status, blocked };
}

function safeHttpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function isSystemMetric(value: unknown): value is SystemMetric {
  return value === 'kills' || value === 'jumps' || value === 'industry' || value === 'sovereignty';
}

function finiteNonNegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid number');
  return value;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid integer');
  return value;
}

function positiveSafeInteger(value: unknown): number {
  if (!isPositiveSafeInteger(value)) throw new Error('invalid identifier');
  return value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error('expected plain object');
  return value;
}
