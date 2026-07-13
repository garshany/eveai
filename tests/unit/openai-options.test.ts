import { describe, expect, it } from 'vitest';
import { toApiReasoningEffort } from '../../src/openai-options.js';

describe('OpenAI options', () => {
  it('keeps API effort values and resolves local auto to the internal-call baseline', () => {
    expect(toApiReasoningEffort('auto')).toBe('medium');
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(toApiReasoningEffort(effort)).toBe(effort);
    }
  });
});
