/**
 * Token cost accounting.
 *
 * ModelHub does not expose prices (verified against the live API: /v1/models
 * carries no price field and every billing-ish endpoint 404s), so tariffs live
 * in config as USD per 1M tokens, keyed by model id. All money math here is
 * integer microdollars ($1 = 1_000_000) — never REAL/float columns.
 *
 * Counter semantics follow the Responses API payload (see native-responses.ts):
 *   - `cached` is a subset of `input`  → uncached input = input - cached
 *   - `reasoning` is a subset of `output` → visible output = output - reasoning
 *   - `cacheWrite` tokens are input tokens and bill at the plain input rate
 *     (they are already inside the uncached-input term), so no fifth tariff.
 * An unknown tariff yields null — the caller must surface "cost unknown" and
 * must never store 0 instead: 0 reads as "free" in the UI and would be a lie.
 */
export type ModelPricing = {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M visible (non-reasoning) output tokens. */
  output: number;
  /** USD per 1M cached input tokens. */
  cached: number;
  /** USD per 1M reasoning tokens. */
  reasoning: number;
};

export type ModelPricingTable = Record<string, ModelPricing>;

export type UsageTokenCounts = {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
};

const PRICING_KEYS = ['input', 'output', 'cached', 'reasoning'] as const;

/**
 * Parse MODEL_PRICING_JSON: `{"model-id": {"input": 1.25, "output": 10, "cached": 0.125, "reasoning": 10}}`.
 * Empty/unset means "no tariffs known" — costs will report as unknown, not zero.
 * Strict on purpose: a typo'd tariff must fail startup, not silently misprice.
 */
export function parseModelPricingJson(raw: string | undefined): ModelPricingTable {
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MODEL_PRICING_JSON must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('MODEL_PRICING_JSON must be a JSON object keyed by model id');
  }
  const table: ModelPricingTable = {};
  for (const [model, value] of Object.entries(parsed)) {
    if (!model.trim()) throw new Error('MODEL_PRICING_JSON contains an empty model id');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`MODEL_PRICING_JSON["${model}"] must be an object with input/output/cached/reasoning rates`);
    }
    const entry = value as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!(PRICING_KEYS as readonly string[]).includes(key)) {
        throw new Error(`MODEL_PRICING_JSON["${model}"] has unknown rate "${key}" (expected: ${PRICING_KEYS.join(', ')})`);
      }
    }
    const pricing = {} as Record<(typeof PRICING_KEYS)[number], number>;
    for (const key of PRICING_KEYS) {
      const rate = entry[key];
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
        throw new Error(`MODEL_PRICING_JSON["${model}"].${key} must be a non-negative finite number (USD per 1M tokens)`);
      }
      pricing[key] = rate;
    }
    table[model] = pricing;
  }
  return table;
}

/**
 * Cost of one model response in integer microdollars, or null when the model
 * has no configured tariff. With rates in USD per 1M tokens the identity
 * microdollars = tokens × rate holds exactly, so a single Math.round at the
 * end is the only rounding step; token counts stay far below 2^53.
 */
export function computeUsageCostMicros(
  usage: UsageTokenCounts,
  pricing: ModelPricingTable,
  model: string,
): number | null {
  const tariff = pricing[model];
  if (!tariff) return null;
  // Clamp subsets at their supersets instead of trusting provider arithmetic:
  // a malformed payload (cached > input) must not inflate or negate the cost.
  const cached = Math.min(Math.max(0, usage.cached), Math.max(0, usage.input));
  const reasoning = Math.min(Math.max(0, usage.reasoning), Math.max(0, usage.output));
  const uncachedInput = Math.max(0, usage.input) - cached;
  const visibleOutput = Math.max(0, usage.output) - reasoning;
  const micros =
    uncachedInput * tariff.input +
    cached * tariff.cached +
    visibleOutput * tariff.output +
    reasoning * tariff.reasoning;
  return Math.round(micros);
}
