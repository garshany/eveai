import { describe, expect, it } from 'vitest';
import { buildCanonicalLoopbackUrl } from '../../src/web/canonical-origin.js';

describe('canonical web origin', () => {
  it('redirects the localhost alias to the configured loopback origin', () => {
    expect(buildCanonicalLoopbackUrl(
      'http://127.0.0.1:3000',
      '/app?connected=1',
      'http',
      'localhost:3000',
    )).toBe('http://127.0.0.1:3000/app?connected=1');
  });

  it('does not redirect the already canonical origin', () => {
    expect(buildCanonicalLoopbackUrl(
      'http://127.0.0.1:3000',
      '/app',
      'http',
      '127.0.0.1:3000',
    )).toBeNull();
  });

  it('does not trust external hosts or a different local port', () => {
    expect(buildCanonicalLoopbackUrl(
      'http://127.0.0.1:3000',
      '/app',
      'http',
      'attacker.invalid:3000',
    )).toBeNull();
    expect(buildCanonicalLoopbackUrl(
      'http://127.0.0.1:3000',
      '/app',
      'http',
      'localhost:5173',
    )).toBeNull();
  });
});
