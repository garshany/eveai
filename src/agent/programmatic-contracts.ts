export const MAX_PROGRAMMATIC_TOOL_OUTPUT_CHARS = 12_000;

export const PROGRAMMATIC_TOOL_NAMES = [
  'count_universe_objects',
  'batch_market_prices',
  'compare_wormhole_types',
  'scout_systems',
  'kill_activity_summary',
  'market_history_summary',
  'system_metric_snapshot',
  'doctrine_summary',
  'dynamic_item_summary',
] as const;

export type ProgrammaticToolName = (typeof PROGRAMMATIC_TOOL_NAMES)[number];

export const PROGRAMMATIC_TOOL_ALLOWLIST: ReadonlySet<ProgrammaticToolName> = new Set(
  PROGRAMMATIC_TOOL_NAMES,
);

export type JsonSchema = Readonly<Record<string, unknown>>;

export type JsonSchemaValidation =
  | { valid: true; errors: [] }
  | { valid: false; errors: string[] };

const FRESHNESS_SCHEMA = objectSchema({
  retrieved_at: { type: 'string', format: 'date-time' },
  data_through: { type: ['string', 'null'], format: 'date-time' },
  cache_max_age_seconds: { type: ['integer', 'null'], minimum: 0 },
});

const COUNT_UNIVERSE_OBJECTS_OUTPUT_SCHEMA = {
  anyOf: [
    objectSchema(
      {
        ok: { const: true },
        target_kind: { type: 'string', enum: ['system', 'constellation', 'region'] },
        target_name: { type: 'string' },
        object_kind: {
          type: 'string',
          enum: [
            'constellations',
            'systems',
            'planets',
            'moons',
            'asteroid_belts',
            'stations',
            'stargates',
          ],
        },
        count: { type: 'integer' },
        system_id: { type: 'integer' },
        constellation_id: { type: 'integer' },
        region_id: { type: 'integer' },
        constellation_name: { type: ['string', 'null'] },
        region_name: { type: ['string', 'null'] },
        planet_count: { type: 'integer' },
        system_count: { type: 'integer' },
      },
      ['ok', 'target_kind', 'target_name', 'object_kind', 'count'],
    ),
    objectSchema(
      {
        ok: { const: false },
        error: { type: 'string', minLength: 1, maxLength: 256 },
        blocked: { type: 'boolean' },
      },
      ['ok', 'error'],
    ),
  ],
} as const satisfies JsonSchema;

const MARKET_ERROR_SCHEMA = facadeErrorSchema('CCP ESI', true);
const EVE_SCOUT_ERROR_SCHEMA = facadeErrorSchema('EVE-Scout', false);
const EVE_KILL_ERROR_SCHEMA = facadeErrorSchema('EVE-KILL', false);
const EVE_KILL_MCP_ERROR_SCHEMA = facadeErrorSchema('EVE-KILL MCP', false);

const BATCH_MARKET_PRICES_OUTPUT_SCHEMA = {
  anyOf: [
    objectSchema({
      ok: { const: true },
      source: { const: 'CCP ESI' },
      authoritative: { const: true },
      freshness: FRESHNESS_SCHEMA,
      region_id: { type: 'integer', minimum: 1 },
      prices: {
        type: 'array',
        minItems: 1,
        maxItems: 30,
        items: objectSchema({
          type_id: { type: 'integer', minimum: 1 },
          sell: {
            type: ['object', 'null'],
            properties: {
              min_price: { type: 'number', minimum: 0 },
              volume: { type: 'integer', minimum: 0 },
              orders: { type: 'integer', minimum: 0 },
            },
            required: ['min_price', 'volume', 'orders'],
            additionalProperties: false,
          },
          buy: {
            type: ['object', 'null'],
            properties: {
              max_price: { type: 'number', minimum: 0 },
              volume: { type: 'integer', minimum: 0 },
              orders: { type: 'integer', minimum: 0 },
            },
            required: ['max_price', 'volume', 'orders'],
            additionalProperties: false,
          },
          global_average_price: { type: ['number', 'null'], minimum: 0 },
          error: { type: ['string', 'null'], maxLength: 256 },
        }),
      },
    }),
    MARKET_ERROR_SCHEMA,
  ],
} as const satisfies JsonSchema;

const COMPARE_WORMHOLE_TYPES_OUTPUT_SCHEMA = {
  anyOf: [
    objectSchema({
      ok: { const: true },
      source: { const: 'EVE-Scout' },
      authoritative: { const: false },
      limitation: {
        const: 'Third-party public EVE-Scout data; entries may be stale or incomplete.',
      },
      freshness: objectSchema({
        retrieved_at: { type: 'string', format: 'date-time' },
        data_through: { type: ['string', 'null'], format: 'date-time' },
        cache_max_age_seconds: { const: 86_400 },
      }),
      wormhole_types: {
        type: 'array',
        minItems: 2,
        maxItems: 8,
        items: objectSchema({
          identifier: { type: 'string', pattern: '^[A-Z][0-9]{3}$' },
          found: { type: 'boolean' },
          type_id: { type: ['integer', 'null'], minimum: 1 },
          max_jump_mass: { type: ['number', 'null'], minimum: 0 },
          max_stable_mass: { type: ['number', 'null'], minimum: 0 },
          lifetime_minutes: { type: ['integer', 'null'], minimum: 0 },
          mass_regeneration: { type: ['number', 'null'], minimum: 0 },
          source_classes: { type: 'array', items: { type: 'string' } },
          target_class: { type: ['string', 'null'] },
          possible_static: { type: ['boolean', 'null'] },
          wandering_only: { type: ['boolean', 'null'] },
        }),
      },
    }),
    EVE_SCOUT_ERROR_SCHEMA,
  ],
} as const satisfies JsonSchema;

const SCOUT_SYSTEMS_OUTPUT_SCHEMA = {
  anyOf: [
    objectSchema({
      ok: { const: true },
      source: { const: 'EVE-Scout' },
      authoritative: { const: false },
      limitation: {
        const: 'Third-party public EVE-Scout classification; results may be stale or incomplete.',
      },
      freshness: objectSchema({
        retrieved_at: { type: 'string', format: 'date-time' },
        data_through: { type: ['string', 'null'], format: 'date-time' },
        cache_max_age_seconds: { const: 86_400 },
      }),
      query: { type: 'string', minLength: 1, maxLength: 64 },
      space: {
        type: ['string', 'null'],
        enum: ['hs', 'ls', 'ns', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c12', 'c13', null],
      },
      count: { type: 'integer', minimum: 0, maximum: 25 },
      systems: {
        type: 'array',
        maxItems: 25,
        items: objectSchema({
          system_id: { type: 'integer', minimum: 1 },
          system_name: { type: 'string', minLength: 1 },
          system_class: { type: 'string', minLength: 1 },
          security_status: { type: 'number' },
          region_id: { type: 'integer', minimum: 1 },
          region_name: { type: 'string', minLength: 1 },
          jove_observatory: { type: 'boolean' },
        }),
      },
    }),
    EVE_SCOUT_ERROR_SCHEMA,
  ],
} as const satisfies JsonSchema;

const KILL_ACTIVITY_SUMMARY_OUTPUT_SCHEMA = {
  anyOf: [
    objectSchema({
      ok: { const: true },
      source: { const: 'EVE-KILL' },
      authoritative: { const: false },
      limitation: { const: 'Third-party public killboard observation; coverage may be incomplete.' },
      freshness: FRESHNESS_SCHEMA,
      scope: { type: 'string', enum: ['system', 'character', 'corporation', 'alliance'] },
      id: { type: 'integer', minimum: 1 },
      activity: { type: 'string', enum: ['kills', 'losses', 'all'] },
      window: objectSchema({
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
      }),
      coverage: objectSchema({
        observed: { type: 'integer', minimum: 0, maximum: 100 },
        truncated: { type: 'boolean' },
      }),
      aggregates: objectSchema({
        kills: { type: 'integer', minimum: 0, maximum: 100 },
        losses: { type: 'integer', minimum: 0, maximum: 100 },
        dual_role: { type: 'integer', minimum: 0, maximum: 100 },
        npc: { type: 'integer', minimum: 0, maximum: 100 },
        solo: { type: 'integer', minimum: 0, maximum: 100 },
        valued: { type: 'integer', minimum: 0, maximum: 100 },
        total_value_isk: { type: 'number', minimum: 0 },
        first_killmail_time: { type: ['string', 'null'], format: 'date-time' },
        last_killmail_time: { type: ['string', 'null'], format: 'date-time' },
      }),
      evidence_killmail_ids: {
        type: 'array',
        maxItems: 10,
        uniqueItems: true,
        items: { type: 'integer', minimum: 1 },
      },
    }),
    EVE_KILL_ERROR_SCHEMA,
  ],
} as const satisfies JsonSchema;

const MARKET_HISTORY_SUMMARY_OUTPUT_SCHEMA = {
  anyOf: [
    objectSchema({
      ok: { const: true },
      source: { const: 'CCP ESI' },
      authoritative: { const: true },
      freshness: FRESHNESS_SCHEMA,
      region_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      type_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      requested_days: { type: 'integer', enum: [30, 90] },
      window: objectSchema({
        first_date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        last_date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      }),
      observed_days: { type: 'integer', minimum: 0, maximum: 90 },
      price: objectSchema({
        lowest: { type: ['number', 'null'], minimum: 0 },
        highest: { type: ['number', 'null'], minimum: 0 },
        mean_daily_average: { type: ['number', 'null'], minimum: 0 },
        volume_weighted_average: { type: ['number', 'null'], minimum: 0 },
        change_percent: { type: ['number', 'null'] },
      }),
      volume: objectSchema({
        total: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        mean_per_observed_day: { type: ['number', 'null'], minimum: 0 },
      }),
      volatility: objectSchema({
        daily_return_stddev_percent: { type: ['number', 'null'], minimum: 0 },
      }),
      liquidity: objectSchema({
        total_orders: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        mean_orders_per_observed_day: { type: ['number', 'null'], minimum: 0 },
        active_days: { type: 'integer', minimum: 0, maximum: 90 },
      }),
    }),
    MARKET_ERROR_SCHEMA,
  ],
} as const satisfies JsonSchema;

const SYSTEM_METRIC_COMMON_PROPERTIES = {
  ok: { const: true },
  source: { const: 'CCP ESI' },
  authoritative: { const: true },
  freshness: FRESHNESS_SCHEMA,
  count: { type: 'integer', minimum: 1, maximum: 100 },
} as const satisfies Record<string, JsonSchema>;

const SYSTEM_METRIC_SNAPSHOT_OUTPUT_SCHEMA = {
  anyOf: [
    objectSchema({
      ...SYSTEM_METRIC_COMMON_PROPERTIES,
      metric: { const: 'kills' },
      rows: {
        type: 'array', minItems: 1, maxItems: 100,
        items: objectSchema({
          system_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          found: { type: 'boolean' },
          ship: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          npc: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          pod: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        }),
      },
    }),
    objectSchema({
      ...SYSTEM_METRIC_COMMON_PROPERTIES,
      metric: { const: 'jumps' },
      rows: {
        type: 'array', minItems: 1, maxItems: 100,
        items: objectSchema({
          system_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          found: { type: 'boolean' },
          jumps: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        }),
      },
    }),
    objectSchema({
      ...SYSTEM_METRIC_COMMON_PROPERTIES,
      metric: { const: 'industry' },
      rows: {
        type: 'array', minItems: 1, maxItems: 100,
        items: objectSchema({
          system_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          found: { type: 'boolean' },
          cost_indices: {
            type: 'array', minItems: 6, maxItems: 6,
            items: { type: ['number', 'null'], minimum: 0 },
          },
        }),
      },
    }),
    objectSchema({
      ...SYSTEM_METRIC_COMMON_PROPERTIES,
      metric: { const: 'sovereignty' },
      rows: {
        type: 'array', minItems: 1, maxItems: 100,
        items: objectSchema({
          system_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          found: { type: 'boolean' },
          holder_type: { type: 'string', enum: ['alliance', 'corporation', 'faction', 'none'] },
          holder_id: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        }),
      },
    }),
    MARKET_ERROR_SCHEMA,
  ],
} as const satisfies JsonSchema;

const DOCTRINE_SUMMARY_OUTPUT_SCHEMA = {
  anyOf: [
    objectSchema({
      ok: { const: true },
      source: { const: 'EVE-KILL MCP' },
      authoritative: { const: false },
      limitation: {
        const: 'Third-party public loss-fit inference; coverage and doctrine classifications may be incomplete.',
      },
      freshness: FRESHNESS_SCHEMA,
      entity: objectSchema({
        id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        type: { type: 'string', enum: ['corporation', 'alliance'] },
        name: { type: 'string', minLength: 1, maxLength: 128 },
      }),
      window: objectSchema({
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
      }),
      count: { type: 'integer', minimum: 0, maximum: 10 },
      doctrines: {
        type: 'array', maxItems: 10,
        items: objectSchema({
          family_id: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          signature: { type: 'string', minLength: 1, maxLength: 256 },
          ship_type_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          ship_name: { type: 'string', minLength: 1, maxLength: 128 },
          losses: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          isk_lost: { type: 'number', minimum: 0 },
          average_isk_per_loss: { type: 'number', minimum: 0 },
          first_loss: { type: 'string', format: 'date-time' },
          last_loss: { type: 'string', format: 'date-time' },
          evidence_killmail_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        }),
      },
    }),
    EVE_KILL_MCP_ERROR_SCHEMA,
  ],
} as const satisfies JsonSchema;

const DYNAMIC_ITEM_SUMMARY_OUTPUT_SCHEMA = {
  anyOf: [
    objectSchema({
      ok: { const: true },
      source: { const: 'CCP ESI' },
      authoritative: { const: true },
      freshness: FRESHNESS_SCHEMA,
      type_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      item_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      source_type_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      mutator_type_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      attributes: {
        type: 'array', minItems: 1, maxItems: 20,
        items: objectSchema({
          attribute_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          found: { type: 'boolean' },
          value: { type: ['number', 'null'] },
          base_value: { type: ['number', 'null'] },
          delta: { type: ['number', 'null'] },
          delta_percent: { type: ['number', 'null'] },
        }),
      },
    }),
    MARKET_ERROR_SCHEMA,
  ],
} as const satisfies JsonSchema;

export const PROGRAMMATIC_OUTPUT_SCHEMAS: Readonly<
  Record<ProgrammaticToolName, JsonSchema>
> = {
  count_universe_objects: COUNT_UNIVERSE_OBJECTS_OUTPUT_SCHEMA,
  batch_market_prices: BATCH_MARKET_PRICES_OUTPUT_SCHEMA,
  compare_wormhole_types: COMPARE_WORMHOLE_TYPES_OUTPUT_SCHEMA,
  scout_systems: SCOUT_SYSTEMS_OUTPUT_SCHEMA,
  kill_activity_summary: KILL_ACTIVITY_SUMMARY_OUTPUT_SCHEMA,
  market_history_summary: MARKET_HISTORY_SUMMARY_OUTPUT_SCHEMA,
  system_metric_snapshot: SYSTEM_METRIC_SNAPSHOT_OUTPUT_SCHEMA,
  doctrine_summary: DOCTRINE_SUMMARY_OUTPUT_SCHEMA,
  dynamic_item_summary: DYNAMIC_ITEM_SUMMARY_OUTPUT_SCHEMA,
};

const OUTPUT_ERROR_MESSAGES = {
  invalid: 'Tool output failed local schema validation.',
  too_large: 'Tool output exceeded the local size limit.',
  serialization: 'Tool output could not be serialized safely.',
} as const;

type OutputErrorReason = keyof typeof OUTPUT_ERROR_MESSAGES;

export function isProgrammaticToolName(name: string): name is ProgrammaticToolName {
  return PROGRAMMATIC_TOOL_ALLOWLIST.has(name as ProgrammaticToolName);
}

export function getProgrammaticOutputSchema(name: string): JsonSchema | undefined {
  return isProgrammaticToolName(name) ? PROGRAMMATIC_OUTPUT_SCHEMAS[name] : undefined;
}

export function validateProgrammaticToolOutput(
  name: ProgrammaticToolName,
  value: unknown,
): JsonSchemaValidation {
  return validateJsonSchema(PROGRAMMATIC_OUTPUT_SCHEMAS[name], value);
}

/**
 * Serializes only schema-valid output. Invalid, non-JSON, or oversized values
 * are replaced wholesale by a small fixed error arm for the selected facade.
 * No upstream value or validation detail is copied into that arm.
 */
export function serializeProgrammaticToolOutput(
  name: ProgrammaticToolName,
  value: unknown,
): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return serializeOutputError(name, 'serialization');
  }

  if (serialized === undefined) return serializeOutputError(name, 'serialization');
  if (serialized.length > MAX_PROGRAMMATIC_TOOL_OUTPUT_CHARS) {
    return serializeOutputError(name, 'too_large');
  }

  let emittedValue: unknown;
  try {
    emittedValue = JSON.parse(serialized) as unknown;
  } catch {
    return serializeOutputError(name, 'serialization');
  }

  if (!validateProgrammaticToolOutput(name, emittedValue).valid) {
    return serializeOutputError(name, 'invalid');
  }
  return serialized;
}

export function validateJsonSchema(schema: JsonSchema, value: unknown): JsonSchemaValidation {
  const errors: string[] = [];
  validateSchemaNode(schema, value, '$', errors);
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

function serializeOutputError(name: ProgrammaticToolName, reason: OutputErrorReason): string {
  const fallback = outputError(name, OUTPUT_ERROR_MESSAGES[reason]);
  const validation = validateProgrammaticToolOutput(name, fallback);
  if (!validation.valid) {
    throw new Error(`Invalid local output error contract for ${name}`);
  }
  const serialized = JSON.stringify(fallback);
  if (serialized.length > MAX_PROGRAMMATIC_TOOL_OUTPUT_CHARS) {
    throw new Error(`Local output error contract exceeds the size limit for ${name}`);
  }
  return serialized;
}

function outputError(name: ProgrammaticToolName, error: string): Record<string, unknown> {
  if (name === 'count_universe_objects') return { ok: false, error, blocked: false };
  if (
    name === 'batch_market_prices'
    || name === 'market_history_summary'
    || name === 'system_metric_snapshot'
    || name === 'dynamic_item_summary'
  ) {
    return {
      ok: false,
      source: 'CCP ESI',
      authoritative: true,
      error,
      status: null,
      blocked: false,
    };
  }
  if (name === 'kill_activity_summary') {
    return {
      ok: false,
      source: 'EVE-KILL',
      authoritative: false,
      error,
      status: null,
      blocked: false,
    };
  }
  if (name === 'doctrine_summary') {
    return {
      ok: false,
      source: 'EVE-KILL MCP',
      authoritative: false,
      error,
      status: null,
      blocked: false,
    };
  }
  return {
    ok: false,
    source: 'EVE-Scout',
    authoritative: false,
    error,
    status: null,
    blocked: false,
  };
}

function facadeErrorSchema(source: string, authoritative: boolean): JsonSchema {
  return objectSchema({
    ok: { const: false },
    source: { const: source },
    authoritative: { const: authoritative },
    error: { type: 'string', minLength: 1, maxLength: 256 },
    status: { type: ['integer', 'null'], minimum: 100, maximum: 599 },
    blocked: { type: 'boolean' },
  });
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties),
): JsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function validateSchemaNode(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (errors.length >= 8) return;

  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((candidate) => {
      if (!isRecord(candidate)) return false;
      const candidateErrors: string[] = [];
      validateSchemaNode(candidate, value, path, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (!matched) errors.push(`${path} must match one allowed schema`);
    return;
  }

  if ('const' in schema && !schemaValuesEqual(schema.const, value)) {
    errors.push(`${path} must equal its declared constant`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => schemaValuesEqual(entry, value))) {
    errors.push(`${path} must be one of its declared values`);
    return;
  }

  if (schema.type !== undefined && !matchesDeclaredType(schema.type, value)) {
    errors.push(`${path} has the wrong JSON type`);
    return;
  }

  if (typeof value === 'string') validateString(schema, value, path, errors);
  if (typeof value === 'number') validateNumber(schema, value, path, errors);
  if (Array.isArray(value)) validateArray(schema, value, path, errors);
  if (isRecord(value)) validateObject(schema, value, path, errors);
}

function validateString(
  schema: JsonSchema,
  value: string,
  path: string,
  errors: string[],
): void {
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    errors.push(`${path} is shorter than allowed`);
  }
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    errors.push(`${path} is longer than allowed`);
  }
  if (typeof schema.pattern === 'string') {
    let pattern: RegExp;
    try {
      pattern = new RegExp(schema.pattern, 'u');
    } catch {
      errors.push(`${path} uses an invalid local schema pattern`);
      return;
    }
    if (!pattern.test(value)) errors.push(`${path} does not match the required pattern`);
  }
  if (schema.format === 'date-time' && !isRfc3339Instant(value)) {
    errors.push(`${path} must be an RFC3339 instant`);
  }
}

function validateNumber(
  schema: JsonSchema,
  value: number,
  path: string,
  errors: string[],
): void {
  if (!Number.isFinite(value)) {
    errors.push(`${path} must be a finite JSON number`);
    return;
  }
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    errors.push(`${path} is below the minimum`);
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    errors.push(`${path} is above the maximum`);
  }
}

function validateArray(
  schema: JsonSchema,
  value: unknown[],
  path: string,
  errors: string[],
): void {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    errors.push(`${path} has too few items`);
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    errors.push(`${path} has too many items`);
  }
  if (schema.uniqueItems === true) {
    for (let index = 0; index < value.length; index += 1) {
      if (value.slice(0, index).some((entry) => schemaValuesEqual(entry, value[index]))) {
        errors.push(`${path} contains duplicate items`);
        break;
      }
    }
  }
  if (isRecord(schema.items)) {
    for (let index = 0; index < value.length && errors.length < 8; index += 1) {
      validateSchemaNode(schema.items, value[index], `${path}[${index}]`, errors);
    }
  }
}

function validateObject(
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}.${key} is required`);
        if (errors.length >= 8) return;
      }
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(`${path}.${key} is not allowed`);
        if (errors.length >= 8) return;
      }
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (
      Object.prototype.hasOwnProperty.call(value, key)
      && isRecord(propertySchema)
      && errors.length < 8
    ) {
      validateSchemaNode(propertySchema, value[key], `${path}.${key}`, errors);
    }
  }
}

function matchesDeclaredType(type: unknown, value: unknown): boolean {
  const allowed = Array.isArray(type) ? type : [type];
  return allowed.some((entry) => {
    switch (entry) {
      case 'null': return value === null;
      case 'object': return isRecord(value);
      case 'array': return Array.isArray(value);
      case 'string': return typeof value === 'string';
      case 'boolean': return typeof value === 'boolean';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
      default: return false;
    }
  });
}

function schemaValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((entry, index) => schemaValuesEqual(entry, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(right, key)
          && schemaValuesEqual(left[key], right[key]),
      );
  }
  return false;
}

function isRfc3339Instant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
