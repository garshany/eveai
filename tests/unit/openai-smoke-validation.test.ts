import { describe, expect, it } from 'vitest';
import { validateOpenAiSmokeCompletion } from '../../src/openai-smoke-validation.js';

describe('validateOpenAiSmokeCompletion', () => {
  const expected = 'eveai-openai-smoke-ok';

  it('requires a terminal response event', () => {
    expect(() => validateOpenAiSmokeCompletion(null, expected, expected)).toThrow(
      /without a terminal response event/,
    );
  });

  it('rejects an empty or unexpected answer', () => {
    expect(() => validateOpenAiSmokeCompletion({ id: 'resp_1' }, '', expected)).toThrow(
      /unexpected smoke text/,
    );
    expect(() => validateOpenAiSmokeCompletion({ output_text: 'not-ok' }, '', expected)).toThrow(
      /unexpected smoke text/,
    );
  });

  it('accepts only the exact marker and returns safe metadata', () => {
    expect(validateOpenAiSmokeCompletion({
      id: 'resp_123',
      model: 'gpt-5.6-sol',
      output_text: expected,
    }, '', expected)).toEqual({
      text: expected,
      id: 'resp_123',
      model: 'gpt-5.6-sol',
    });
  });
});
