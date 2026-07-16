import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders } from '../../src/web/security.js';

describe('web security headers', () => {
  it('allows the official EVE SSO origin through the consent form redirect chain', () => {
    const headers = buildSecurityHeaders({ baseUrl: 'http://127.0.0.1:3000' });

    expect(headers['Content-Security-Policy']).toContain(
      "form-action 'self' https://login.eveonline.com http://127.0.0.1:3000",
    );
  });
});
