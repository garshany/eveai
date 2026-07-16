import type { NativeFunctionTool } from '../agent/native-responses.js';
import type { Db } from '../db/sqlite.js';
import { isCanonicalIsoTimestamp } from './normalize.js';
import { executeEveKillAnalyticsTool } from './mcp-analytics.js';

const ARGUMENT_KEYS = new Set(['entity_id', 'entity_type', 'from', 'to', 'top']);
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_OUTPUT_CHARS = 12_000;
const FAMILY_HASH = /^[0-9a-f]{64}$/;
const LIMITATION = 'Third-party public loss-fit inference; coverage and doctrine classifications may be incomplete.';

export type DoctrineEntityType = 'corporation' | 'alliance';
export type DoctrineSummaryArgs = {
  entity_id: number;
  entity_type: DoctrineEntityType;
  from: string;
  to: string;
  top: number;
};
export type DoctrineSummaryError = {
  ok: false;
  source: 'EVE-KILL MCP';
  authoritative: false;
  error: string;
  status: number | null;
  blocked: boolean;
};

export const DOCTRINE_SUMMARY_TOOL: NativeFunctionTool = {
  type: 'function',
  name: 'doctrine_summary',
  description:
    'Project bounded public EVE-KILL doctrine inference for one exact corporation or alliance and explicit window. '
    + 'Returns stable aggregate evidence only, excluding raw clusters, URLs, module lists, transport data, and private context.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      entity_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      entity_type: { type: 'string', enum: ['corporation', 'alliance'] },
      from: { type: 'string', description: 'Canonical RFC3339 window start with an explicit timezone.' },
      to: { type: 'string', description: 'Canonical RFC3339 window end, strictly after from.' },
      top: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['entity_id', 'entity_type', 'from', 'to', 'top'],
    additionalProperties: false,
  },
};

export function isDoctrineSummaryTool(name: string): boolean {
  return name === DOCTRINE_SUMMARY_TOOL.name;
}

export function validateDoctrineSummaryArgs(
  args: Record<string, unknown>,
  options: { programmatic?: boolean } = {},
): { ok: true; data: DoctrineSummaryArgs } | { ok: false; error: DoctrineSummaryError } {
  const topLimit = options.programmatic ? 5 : 10;
  if (!isPlainRecord(args) || Object.keys(args).length !== ARGUMENT_KEYS.size
    || Object.keys(args).some((key) => !ARGUMENT_KEYS.has(key))
    || !isPositiveSafeInteger(args.entity_id)
    || !isDoctrineEntityType(args.entity_type)
    || typeof args.from !== 'string'
    || typeof args.to !== 'string'
    || !isCanonicalIsoTimestamp(args.from)
    || !isCanonicalIsoTimestamp(args.to)
    || typeof args.top !== 'number'
    || !Number.isSafeInteger(args.top)
    || args.top < 1
    || args.top > topLimit) {
    return invalidArguments();
  }
  const fromMs = Date.parse(args.from);
  const toMs = Date.parse(args.to);
  if (fromMs >= toMs || toMs - fromMs > MAX_WINDOW_MS) return invalidArguments();
  return {
    ok: true,
    data: {
      entity_id: args.entity_id,
      entity_type: args.entity_type,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      top: args.top,
    },
  };
}

export async function executeDoctrineSummary(
  _db: Db,
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = validateDoctrineSummaryArgs(rawArgs);
  if (!parsed.ok) return parsed.error;
  const args = parsed.data;
  try {
    const response = await executeEveKillAnalyticsTool('doctrine_detect', {
      entity: args.entity_id,
      type: args.entity_type,
      since: args.from,
      until: args.to,
      include_rookie_ships: false,
      limit: args.top,
    });
    if (response.ok !== true) return upstreamFailure(response.status);
    if (response.source !== 'EVE-KILL MCP' || response.tool !== 'doctrine_detect'
      || response.transport !== 'local_public_wrapper' || response.authoritative !== false) {
      throw new Error('invalid wrapper response');
    }
    const projection = projectDoctrine(args, response.data);
    return safeResult(projection);
  } catch {
    return facadeError('EVE-KILL MCP returned an invalid doctrine response.');
  }
}

function projectDoctrine(args: DoctrineSummaryArgs, value: unknown): Record<string, unknown> {
  const data = record(value);
  const entity = record(data.entity);
  const window = record(data.window);
  const entityId = positiveSafeInteger(entity.id);
  if (entityId !== args.entity_id || entity.type !== args.entity_type) throw new Error('entity mismatch');
  const entityName = boundedTrimmedString(entity.name, 128);
  const windowFrom = upstreamTimestamp(window.since);
  const windowTo = upstreamTimestamp(window.until);
  if (windowFrom !== args.from || windowTo !== args.to) throw new Error('window mismatch');
  const count = nonNegativeSafeInteger(data.count);
  if (!Array.isArray(data.clusters) || count !== data.clusters.length || count > args.top) {
    throw new Error('invalid cluster count');
  }

  const familyIds = new Set<string>();
  const doctrines = data.clusters.map((valueCluster) => {
    const cluster = record(valueCluster);
    const familyId = typeof cluster.family_hash === 'string' && FAMILY_HASH.test(cluster.family_hash)
      ? cluster.family_hash
      : null;
    if (!familyId || familyIds.has(familyId)) throw new Error('invalid family hash');
    familyIds.add(familyId);
    const ship = record(cluster.ship);
    const example = record(cluster.example_killmail);
    const firstLoss = upstreamTimestamp(cluster.first_loss);
    const lastLoss = upstreamTimestamp(cluster.last_loss);
    if (Date.parse(firstLoss) > Date.parse(lastLoss)
      || Date.parse(firstLoss) < Date.parse(args.from)
      || Date.parse(lastLoss) > Date.parse(args.to)) {
      throw new Error('cluster window mismatch');
    }
    validateExcludedExampleFields(example);
    return {
      family_id: familyId,
      signature: boundedTrimmedString(cluster.signature, 256),
      ship_type_id: positiveSafeInteger(ship.type_id),
      ship_name: boundedTrimmedString(ship.name, 128),
      losses: nonNegativeSafeInteger(cluster.losses),
      isk_lost: round(nonNegativeFinite(cluster.isk_lost)),
      average_isk_per_loss: round(nonNegativeFinite(cluster.avg_isk_per_loss)),
      first_loss: firstLoss,
      last_loss: lastLoss,
      evidence_killmail_id: positiveSafeInteger(example.killmail_id),
    };
  });
  const dataThrough = doctrines.reduce<string | null>((latest, doctrine) => (
    latest === null || Date.parse(doctrine.last_loss) > Date.parse(latest) ? doctrine.last_loss : latest
  ), null);

  return {
    ok: true,
    source: 'EVE-KILL MCP',
    authoritative: false,
    limitation: LIMITATION,
    freshness: {
      retrieved_at: new Date().toISOString(),
      data_through: dataThrough,
      cache_max_age_seconds: null,
    },
    entity: { id: entityId, type: args.entity_type, name: entityName },
    window: { from: args.from, to: args.to },
    count: doctrines.length,
    doctrines,
  };
}

function validateExcludedExampleFields(example: Record<string, unknown>): void {
  if (typeof example.url !== 'string' || example.url.length < 1 || example.url.length > 2_048) {
    throw new Error('invalid example URL');
  }
  if (!Array.isArray(example.modules) || example.modules.length > 100) throw new Error('invalid example modules');
  for (const module of example.modules) {
    assertJsonValue(module);
  }
}

function upstreamTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid timestamp');
  let normalized = value;
  const databaseTimestamp = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(value);
  if (databaseTimestamp) {
    normalized = `${databaseTimestamp[1]}T${databaseTimestamp[2]}${databaseTimestamp[3]}:${databaseTimestamp[4] ?? '00'}`;
  }
  if (!isCanonicalIsoTimestamp(normalized)) throw new Error('invalid timestamp');
  return new Date(Date.parse(normalized)).toISOString();
}

function safeResult(value: Record<string, unknown>): Record<string, unknown> {
  try {
    assertJsonValue(value);
    if (JSON.stringify(value).length > MAX_OUTPUT_CHARS) {
      return facadeError('EVE-KILL doctrine summary exceeded the safe output limit.');
    }
    return value;
  } catch {
    return facadeError('EVE-KILL MCP returned an invalid doctrine response.');
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

function boundedTrimmedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string') throw new Error('invalid string');
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid string');
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maximum) throw new Error('invalid string');
  return trimmed;
}

function round(value: number): number {
  if (!Number.isFinite(value)) throw new Error('non-finite result');
  const rounded = Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function invalidArguments(): { ok: false; error: DoctrineSummaryError } {
  return { ok: false, error: facadeError('Invalid doctrine_summary arguments.', null, true) };
}

function upstreamFailure(status: unknown): DoctrineSummaryError {
  const safeStatus = safeHttpStatus(status);
  return facadeError(
    safeStatus === null ? 'EVE-KILL doctrine analysis is temporarily unavailable.' : `EVE-KILL doctrine request failed with HTTP status ${safeStatus}.`,
    safeStatus,
  );
}

function facadeError(
  error: string,
  status: number | null = null,
  blocked = false,
): DoctrineSummaryError {
  return { ok: false, source: 'EVE-KILL MCP', authoritative: false, error, status, blocked };
}

function safeHttpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function nonNegativeFinite(value: unknown): number {
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

function isDoctrineEntityType(value: unknown): value is DoctrineEntityType {
  return value === 'corporation' || value === 'alliance';
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
