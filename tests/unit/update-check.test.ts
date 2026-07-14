import { describe, expect, it, vi } from 'vitest';
import { createUpdateChecker, UPDATE_API_URL } from '../../src/update/check.js';
import { compareStableVersions, getAppVersion, parseStableVersion } from '../../src/update/version.js';
import { formatUpdateStatus } from '../../src/update/format.js';

function releaseResponse(
  tag = 'v3.2.0',
  url = `https://github.com/garshany/eveai/releases/tag/${tag}`,
): Response {
  return new Response(JSON.stringify({
    tag_name: tag,
    html_url: url,
    draft: false,
    prerelease: false,
    body: 'UNTRUSTED RELEASE BODY',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('project update checker', () => {
  it('reads the packaged version and compares strict stable semver', () => {
    expect(getAppVersion()).toBe('3.2.0');
    expect(parseStableVersion('3.1.0')).toEqual([3, 1, 0]);
    expect(parseStableVersion('v3.1.0')).toBeNull();
    expect(parseStableVersion('3.2.0-rc.1')).toBeNull();
    expect(compareStableVersions('3.1.0', '3.2.0')).toBe(-1);
    expect(compareStableVersions('3.2.0', '3.2.0')).toBe(0);
    expect(compareStableVersions('4.0.0', '3.2.0')).toBe(1);
  });

  it('reports available/current/ahead and never renders the release body', async () => {
    for (const [current, kind] of [['3.1.0', 'available'], ['3.2.0', 'current'], ['4.0.0', 'ahead']] as const) {
      const fetchImpl = vi.fn(async () => releaseResponse());
      const status = await createUpdateChecker({ fetchImpl, currentVersion: current }).check();
      expect(status.kind).toBe(kind);
      expect(fetchImpl).toHaveBeenCalledWith(UPDATE_API_URL, expect.objectContaining({
        method: 'GET',
        redirect: 'error',
      }));
      expect(formatUpdateStatus(status)).not.toContain('UNTRUSTED');
    }
  });

  it('rejects prereleases, malformed versions, and non-canonical URLs', async () => {
    const badResponses = [
      new Response(JSON.stringify({ tag_name: 'v3.2.0', html_url: 'https://evil.example/release', draft: false, prerelease: false })),
      releaseResponse('v3.2.0-rc.1'),
      new Response(JSON.stringify({ tag_name: 'v3.2.0', html_url: 'https://github.com/garshany/eveai/releases/tag/v3.2.0', draft: false, prerelease: true })),
    ];
    for (const response of badResponses) {
      const status = await createUpdateChecker({
        fetchImpl: vi.fn(async () => response),
        currentVersion: '3.1.0',
      }).check();
      expect(status).toEqual({ kind: 'unavailable', current: '3.1.0', reason: 'invalid_response' });
    }
  });

  it('bounds failures and coalesces concurrent/cached requests', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    let now = 1_000;
    const checker = createUpdateChecker({ fetchImpl, currentVersion: '3.1.0', now: () => now });
    const first = checker.check();
    const second = checker.check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch(releaseResponse());
    await expect(first).resolves.toMatchObject({ kind: 'available' });
    await expect(second).resolves.toMatchObject({ kind: 'available' });
    now += 1_000;
    await checker.check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const limited = await createUpdateChecker({
      fetchImpl: vi.fn(async () => new Response('', { status: 429 })),
      currentVersion: '3.1.0',
    }).check();
    expect(limited).toEqual({ kind: 'unavailable', current: '3.1.0', reason: 'rate_limited' });
  });

  it('rejects an oversized response before parsing it', async () => {
    const response = new Response('{}', { headers: { 'content-length': '70000' } });
    const status = await createUpdateChecker({
      fetchImpl: vi.fn(async () => response),
      currentVersion: '3.1.0',
    }).check();
    expect(status).toEqual({ kind: 'unavailable', current: '3.1.0', reason: 'invalid_response' });
  });
});
