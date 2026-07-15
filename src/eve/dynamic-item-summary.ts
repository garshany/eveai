import type { NativeFunctionTool } from '../agent/native-responses.js';
import type { Db } from '../db/sqlite.js';
import { callEsiOperation } from './esi-client.js';

const ARGUMENT_KEYS = new Set(['type_id', 'item_id', 'attribute_ids']);
const MAX_OUTPUT_CHARS = 12_000;

export type DynamicItemSummaryArgs = {
  type_id: number;
  item_id: number;
  attribute_ids: number[];
};

export type DynamicItemSummaryError = {
  ok: false;
  source: 'CCP ESI';
  authoritative: true;
  error: string;
  status: number | null;
  blocked: boolean;
};

export const DYNAMIC_ITEM_SUMMARY_TOOL: NativeFunctionTool = {
  type: 'function',
  name: 'dynamic_item_summary',
  description:
    'Read one exact public dynamic dogma item and project only the requested numeric attributes, '
    + 'with optional local-SDE base and delta evidence. Creator identity, effects, unrequested attributes, and raw data are excluded.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      type_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      item_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      attribute_ids: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    required: ['type_id', 'item_id', 'attribute_ids'],
    additionalProperties: false,
  },
};

export function isDynamicItemSummaryTool(name: string): boolean {
  return name === DYNAMIC_ITEM_SUMMARY_TOOL.name;
}

export function validateDynamicItemSummaryArgs(
  args: Record<string, unknown>,
  options: { programmatic?: boolean } = {},
): { ok: true; data: DynamicItemSummaryArgs } | { ok: false; error: DynamicItemSummaryError } {
  const maxAttributes = options.programmatic ? 10 : 20;
  if (!isPlainRecord(args) || Object.keys(args).length !== ARGUMENT_KEYS.size
    || Object.keys(args).some((key) => !ARGUMENT_KEYS.has(key))
    || !isPositiveSafeInteger(args.type_id)
    || !isPositiveSafeInteger(args.item_id)
    || !Array.isArray(args.attribute_ids)
    || args.attribute_ids.length < 1
    || args.attribute_ids.length > maxAttributes
    || args.attribute_ids.some((id) => !isPositiveSafeInteger(id))
    || new Set(args.attribute_ids).size !== args.attribute_ids.length) {
    return invalidArguments();
  }
  return {
    ok: true,
    data: {
      type_id: args.type_id,
      item_id: args.item_id,
      attribute_ids: [...args.attribute_ids] as number[],
    },
  };
}

export async function executeDynamicItemSummary(
  db: Db,
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = validateDynamicItemSummaryArgs(rawArgs);
  if (!parsed.ok) return parsed.error;
  const args = parsed.data;
  try {
    const response = await callEsiOperation(
      db,
      'get_dogma_dynamic_items_type_id_item_id',
      { type_id: args.type_id, item_id: args.item_id },
      null,
    );
    if (!response.ok) return esiFailure(response.status);
    const dynamic = parseDynamicItem(response.data);
    const baseValues = readBaseValues(db, dynamic.sourceTypeId);
    const attributes = args.attribute_ids.map((attributeId) => {
      const value = dynamic.attributes.get(attributeId);
      if (value === undefined) {
        return {
          attribute_id: attributeId,
          found: false,
          value: null,
          base_value: null,
          delta: null,
          delta_percent: null,
        };
      }
      const baseValue = baseValues.get(attributeId) ?? null;
      const rawDelta = baseValue === null ? null : value - baseValue;
      const delta = rawDelta === null ? null : round(rawDelta);
      return {
        attribute_id: attributeId,
        found: true,
        value: round(value),
        base_value: baseValue === null ? null : round(baseValue),
        delta,
        delta_percent: baseValue === null || baseValue === 0 ? null : round((rawDelta! / baseValue) * 100),
      };
    });
    return safeResult({
      ok: true,
      source: 'CCP ESI',
      authoritative: true,
      freshness: {
        retrieved_at: new Date().toISOString(),
        data_through: headerTimestamp(response.headers['last-modified']),
        cache_max_age_seconds: cacheMaxAge(response.headers),
      },
      type_id: args.type_id,
      item_id: args.item_id,
      source_type_id: dynamic.sourceTypeId,
      mutator_type_id: dynamic.mutatorTypeId,
      attributes,
    });
  } catch {
    return facadeError('CCP ESI returned an invalid dynamic item response.');
  }
}

function parseDynamicItem(value: unknown): {
  sourceTypeId: number;
  mutatorTypeId: number;
  attributes: Map<number, number>;
} {
  const item = record(value);
  const sourceTypeId = positiveSafeInteger(item.source_type_id);
  const mutatorTypeId = positiveSafeInteger(item.mutator_type_id);
  if (item.created_by !== undefined && item.created_by !== null) positiveSafeInteger(item.created_by);
  if (!Array.isArray(item.dogma_attributes) || !Array.isArray(item.dogma_effects)) {
    throw new Error('invalid dynamic dogma arrays');
  }
  if (item.dogma_attributes.length > 1_000 || item.dogma_effects.length > 1_000) {
    throw new Error('dynamic dogma arrays exceed item limits');
  }

  const attributes = new Map<number, number>();
  for (const valueAttribute of item.dogma_attributes) {
    const attribute = record(valueAttribute);
    const id = positiveSafeInteger(attribute.attribute_id);
    const number = finite(attribute.value);
    const existing = attributes.get(id);
    if (existing !== undefined && !Object.is(existing, number)) throw new Error('conflicting dogma attribute');
    if (existing === undefined) attributes.set(id, number);
  }
  for (const valueEffect of item.dogma_effects) {
    const effect = record(valueEffect);
    positiveSafeInteger(effect.effect_id);
    if (typeof effect.is_default !== 'boolean') throw new Error('invalid dogma effect');
  }
  return { sourceTypeId, mutatorTypeId, attributes };
}

function readBaseValues(db: Db, sourceTypeId: number): Map<number, number> {
  const result = new Map<number, number>();
  try {
    const row = db.prepare('SELECT data_json FROM sde_type_dogma WHERE type_id = ?').get(sourceTypeId) as
      | { data_json: string }
      | undefined;
    if (!row) return result;
    const data = record(JSON.parse(row.data_json) as unknown);
    if (!Array.isArray(data.dogmaAttributes)) return result;
    for (const valueAttribute of data.dogmaAttributes) {
      if (!isPlainRecord(valueAttribute)) continue;
      const id = valueAttribute.attributeID;
      const value = valueAttribute.value;
      if (isPositiveSafeInteger(id) && typeof value === 'number' && Number.isFinite(value)) {
        if (!result.has(id)) result.set(id, value);
      }
    }
  } catch {
    return new Map();
  }
  return result;
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
  if (!Number.isFinite(value)) throw new Error('non-finite result');
  const rounded = Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function safeResult(value: Record<string, unknown>): Record<string, unknown> {
  try {
    assertJsonValue(value);
    if (JSON.stringify(value).length > MAX_OUTPUT_CHARS) {
      return facadeError('CCP ESI dynamic item summary exceeded the safe output limit.');
    }
    return value;
  } catch {
    return facadeError('CCP ESI returned an invalid dynamic item response.');
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

function invalidArguments(): { ok: false; error: DynamicItemSummaryError } {
  return { ok: false, error: facadeError('Invalid dynamic_item_summary arguments.', null, true) };
}

function esiFailure(status: unknown): DynamicItemSummaryError {
  const safeStatus = safeHttpStatus(status);
  return facadeError(
    safeStatus === null ? 'CCP ESI dynamic item request failed.' : `CCP ESI dynamic item request failed with HTTP status ${safeStatus}.`,
    safeStatus,
  );
}

function facadeError(
  error: string,
  status: number | null = null,
  blocked = false,
): DynamicItemSummaryError {
  return { ok: false, source: 'CCP ESI', authoritative: true, error, status, blocked };
}

function safeHttpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid number');
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
