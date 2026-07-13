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
