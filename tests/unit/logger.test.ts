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

  it('redacts a Telegram bot token embedded in an api.telegram.org URL', () => {
    const text = String(redactLogValue(
      "request to https://api.telegram.org/bot7777777777:AAH_SUPER-SECRET-BOT-TOKEN_xyz/sendMessage failed",
    ));
    expect(text).not.toContain('AAH_SUPER-SECRET-BOT-TOKEN_xyz');
    expect(text).not.toContain('7777777777:');
    expect(text).toContain('bot[redacted]');
  });

  it('redacts Basic auth headers, client secrets, and Discord tokens', () => {
    expect(String(redactLogValue('Authorization: Basic ZXZlLWNsaWVudDpzdXBlci1zZWNyZXQ='))).not.toContain('ZXZl');
    expect(String(redactLogValue('grant_type=refresh_token&client_secret=shh'))).not.toContain('shh');
    expect(String(redactLogValue('{"client_secret":"top-secret","note":"keep"}'))).not.toContain('top-secret');
    expect(String(redactLogValue('{"client_secret":"top-secret","note":"keep"}'))).toContain('keep');
    // A Discord-token-shaped value (three base64url segments), assembled at
    // runtime so the literal never trips secret scanning while still exercising
    // the three-segment redaction rule.
    const seg = ['zzzzzzzzzzzzzzzzzzzzzzzz', 'aBcDeF', 'gHiJkLmNoPqRsTuVwXyZ0123456789'];
    expect(String(redactLogValue(`token ${seg.join('.')}`))).not.toContain(seg[2]);
  });

  it('redacts a bot token carried on an Error message and its cause', () => {
    const cause = new Error('socket to https://api.telegram.org/bot42424242:CAUSE-SECRET-TOKEN-abcdefghij0/sendMessage');
    const err = new Error('send failed: https://api.telegram.org/bot7777777777:MSG-SECRET-TOKEN-abcdefghijkl0/sendMessage');
    (err as { cause?: unknown }).cause = cause;
    const redacted = redactLogValue(err) as Error & { cause?: Error };
    expect(redacted.message).not.toContain('MSG-SECRET-TOKEN');
    expect(String((redacted.cause as Error).message)).not.toContain('CAUSE-SECRET-TOKEN');
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

  it('drops prototype-mutating keys instead of assigning them dynamically', () => {
    // JSON.parse is one of the few ways to get an own "__proto__" key; logged
    // data parsed from an untrusted source could carry one. Copying it with a
    // dynamic assignment would be a prototype-pollution sink.
    const malicious = JSON.parse('{"__proto__":{"polluted":"yes"},"note":"keep"}') as Record<string, unknown>;
    const redacted = redactLogValue(malicious) as Record<string, unknown>;

    expect(redacted.note).toBe('keep');
    expect((redacted as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('polluted');
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
