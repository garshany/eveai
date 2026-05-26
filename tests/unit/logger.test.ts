import { describe, expect, it } from 'vitest';
import { redactLogValue } from '../../src/observability/logger.js';

describe('logger redaction', () => {
  it('redacts bearer tokens, JWT-like values, and proxy passwords', () => {
    const text = String(redactLogValue(
      'Bearer eyJabc.def.ghi http://user:password@example.test access_token=secret-value',
    ));

    expect(text).not.toContain('eyJabc.def.ghi');
    expect(text).not.toContain('password');
    expect(text).not.toContain('secret-value');
    expect(text).toContain('[redacted]');
  });

  it('redacts sensitive object fields recursively', () => {
    expect(redactLogValue({
      ok: true,
      accessToken: 'abc',
      nested: { refresh_token: 'def' },
    })).toEqual({
      ok: true,
      accessToken: '[redacted]',
      nested: { refresh_token: '[redacted]' },
    });
  });
});
