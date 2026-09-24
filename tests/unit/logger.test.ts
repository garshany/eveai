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

  it('survives cyclic objects instead of overflowing the stack', () => {
    const request: Record<string, unknown> = { id: 1, apiKey: 'sk-live' };
    request.self = request;
    request.children = [request];

    const redacted = redactLogValue(request) as Record<string, unknown>;

    expect(redacted.id).toBe(1);
    expect(redacted.apiKey).toBe('[redacted]');
    expect(redacted.self).toBe('[circular]');
    expect(redacted.children).toEqual(['[circular]']);
  });
});
