import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Cloudflare Turnstile verification', () => {
  beforeEach(() => {
    process.env.TURNSTILE_SITE_KEY = 'site-test';
    process.env.TURNSTILE_SECRET_KEY = 'secret-test';
    process.env.TURNSTILE_EXPECTED_HOSTNAME = 'eve.example';
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_EXPECTED_HOSTNAME;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('accepts only a fresh server-verified token for the expected host and action', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      hostname: 'eve.example',
      action: 'session',
      challenge_ts: new Date().toISOString(),
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { verifyTurnstileToken } = await import('../../src/web/turnstile.js');

    await expect(verifyTurnstileToken('valid-token-value', '203.0.113.10', 'session'))
      .resolves.toEqual({ ok: true });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(init.body)).toContain('secret=secret-test');
    expect(String(init.body)).toContain('remoteip=203.0.113.10');
  });

  it.each([
    { hostname: 'attacker.example', action: 'session', challenge_ts: new Date().toISOString() },
    { hostname: 'eve.example', action: 'chat', challenge_ts: new Date().toISOString() },
    { hostname: 'eve.example', action: 'session', challenge_ts: new Date(Date.now() - 600_000).toISOString() },
  ])('fails closed for wrong host, action, or stale token', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      ...payload,
    }), { status: 200 })));
    const { verifyTurnstileToken } = await import('../../src/web/turnstile.js');
    await expect(verifyTurnstileToken('valid-token-value', '203.0.113.10', 'session'))
      .resolves.toEqual({ ok: false, retryable: false });
  });

  it('fails closed without sending malformed or missing tokens upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { verifyTurnstileToken } = await import('../../src/web/turnstile.js');
    await expect(verifyTurnstileToken('', '203.0.113.10', 'session'))
      .resolves.toEqual({ ok: false, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies Siteverify transport failures as retryable without exposing details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret-test leaked upstream')));
    const { verifyTurnstileToken } = await import('../../src/web/turnstile.js');
    await expect(verifyTurnstileToken('valid-token-value', '203.0.113.10', 'session'))
      .resolves.toEqual({ ok: false, retryable: true });
  });

  it('retries a transient network failure once and accepts the recovered verification', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        hostname: 'eve.example',
        action: 'session',
        challenge_ts: new Date().toISOString(),
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { verifyTurnstileToken } = await import('../../src/web/turnstile.js');
    await expect(verifyTurnstileToken('valid-token-value', '203.0.113.10', 'session'))
      .resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops after the retry budget on persistent transport failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('cloudflare unreachable'));
    vi.stubGlobal('fetch', fetchMock);
    const { verifyTurnstileToken } = await import('../../src/web/turnstile.js');
    await expect(verifyTurnstileToken('valid-token-value', '203.0.113.10', 'session'))
      .resolves.toEqual({ ok: false, retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 500, retryable: true, attempts: 2 },
    { status: 429, retryable: true, attempts: 2 },
    { status: 400, retryable: false, attempts: 1 },
    { status: 403, retryable: false, attempts: 1 },
  ])('maps Siteverify HTTP $status to retryable=$retryable', async ({ status, retryable, attempts }) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('error', { status }));
    vi.stubGlobal('fetch', fetchMock);
    const { verifyTurnstileToken } = await import('../../src/web/turnstile.js');
    await expect(verifyTurnstileToken('valid-token-value', '203.0.113.10', 'session'))
      .resolves.toEqual({ ok: false, retryable });
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
  });

  it('treats a Cloudflare internal-error as retryable and a reused token as final', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        'error-codes': ['internal-error'],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        'error-codes': ['internal-error'],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { verifyTurnstileToken } = await import('../../src/web/turnstile.js');
    await expect(verifyTurnstileToken('valid-token-value', '203.0.113.10', 'session'))
      .resolves.toEqual({ ok: false, retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      'error-codes': ['timeout-or-duplicate'],
    }), { status: 200 }));
    await expect(verifyTurnstileToken('reused-token-value', '203.0.113.10', 'session'))
      .resolves.toEqual({ ok: false, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed as retryable when Siteverify returns an unparseable body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { verifyTurnstileToken } = await import('../../src/web/turnstile.js');
    await expect(verifyTurnstileToken('valid-token-value', '203.0.113.10', 'session'))
      .resolves.toEqual({ ok: false, retryable: true });
  });
});
