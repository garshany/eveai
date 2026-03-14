import { describe, it, expect } from 'vitest';
import { truncateForTelegram, sanitizeOutput, finalizeMessage } from '../../src/agent/finalizer.js';

describe('finalizer', () => {
  it('passes short text through unchanged', () => {
    expect(truncateForTelegram('hello')).toBe('hello');
  });

  it('truncates text over 4096 chars', () => {
    const long = 'x'.repeat(5000);
    const result = truncateForTelegram(long);
    expect(result.length).toBeLessThanOrEqual(4096);
    expect(result).toContain('[...ответ обрезан]');
  });

  it('redacts Bearer tokens', () => {
    const text = 'Got: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc.def';
    const result = sanitizeOutput(text);
    expect(result).not.toContain('eyJ');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts standalone JWT tokens', () => {
    const text = 'Token is eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9_something_long_here';
    const result = sanitizeOutput(text);
    expect(result).toContain('[TOKEN_REDACTED]');
  });

  it('finalizeMessage combines truncation and sanitization', () => {
    const text = 'Bearer eyJabc123456789012345678901234567890';
    const result = finalizeMessage(text);
    expect(result).not.toContain('eyJ');
  });
});
