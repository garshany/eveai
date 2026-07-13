import { describe, expect, it } from 'vitest';
import { buildSafetyIdentifier } from '../../src/agent/safety-identifier.js';

describe('buildSafetyIdentifier', () => {
  it('returns a stable opaque identifier without embedding the user id', () => {
    const first = buildSafetyIdentifier(12345, 'test-secret');
    const second = buildSafetyIdentifier(12345, 'test-secret');
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe('12345');
  });

  it('separates users and omits the identifier without a usable secret', () => {
    expect(buildSafetyIdentifier(1, 'test-secret')).not.toBe(buildSafetyIdentifier(2, 'test-secret'));
    expect(buildSafetyIdentifier(1, '')).toBeUndefined();
    expect(buildSafetyIdentifier(0, 'test-secret')).toBeUndefined();
  });
});
