import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders } from '../../src/web/security.js';

describe('web security headers', () => {
  it('allows the official EVE SSO origin through the consent form redirect chain', () => {
    const headers = buildSecurityHeaders({ baseUrl: 'http://127.0.0.1:3000' });

    expect(headers['Content-Security-Policy']).toContain(
      "form-action 'self' https://login.eveonline.com http://127.0.0.1:3000",
    );
  });

  it('permits the Turnstile origin for script, frame and connect when enabled', () => {
    const headers = buildSecurityHeaders({ baseUrl: 'https://eve.example', turnstileEnabled: true });
    const csp = headers['Content-Security-Policy'] ?? '';

    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(csp).toContain('connect-src \'self\' https://eve.example https://challenges.cloudflare.com');
  });

  it('denies all frames and the Turnstile origin when the widget is disabled', () => {
    const headers = buildSecurityHeaders({ baseUrl: 'https://eve.example', turnstileEnabled: false });
    const csp = headers['Content-Security-Policy'] ?? '';

    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toContain('challenges.cloudflare.com');
  });
});
