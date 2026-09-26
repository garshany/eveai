export const RESPONSE_STATE_MODES = ['stateless', 'server'] as const;
export type ResponseStateMode = typeof RESPONSE_STATE_MODES[number];

export const REASONING_EFFORTS = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export type ApiReasoningEffort = Exclude<ReasoningEffort, 'auto'>;

export const REASONING_MODES = ['standard', 'pro'] as const;
export type ReasoningMode = typeof REASONING_MODES[number];

export const TEXT_VERBOSITIES = ['low', 'medium', 'high'] as const;
export type TextVerbosity = typeof TEXT_VERBOSITIES[number];

/** `auto` is an EVE Agent routing policy, not an OpenAI API effort value. */
export function toApiReasoningEffort(value: ReasoningEffort): ApiReasoningEffort {
  return value === 'auto' ? 'medium' : value;
}

/**
 * GPT-6 Astra rejects `reasoning.effort: "none"` (OpenAI model guide); the
 * lowest effort it accepts is `low`. Every other model keeps its value.
 */
export function clampReasoningEffortForModel(model: string, effort: ApiReasoningEffort): ApiReasoningEffort {
  return model === 'gpt-6-astra' && effort === 'none' ? 'low' : effort;
}

/**
 * GPT-6 models accept a `configuration_update` input item that changes the
 * reasoning effort mid-conversation without touching the request-level
 * `reasoning` field. Changing that field invalidates the provider prompt
 * cache for the whole prefix (measured on ModelHub 2026-09-26: 0 cached
 * tokens vs 8960 with an update item), so the agent loop keeps it fixed at
 * this anchor and expresses per-turn/per-iteration effort as an update.
 */
export const CONFIGURATION_UPDATE_ANCHOR_EFFORT: ApiReasoningEffort = 'medium';

export function supportsConfigurationUpdate(model: string): boolean {
  return model.startsWith('gpt-6-');
}
