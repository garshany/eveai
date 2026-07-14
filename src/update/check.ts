import { compareStableVersions, getAppVersion, parseStableVersion } from './version.js';

export const UPDATE_API_URL = 'https://api.github.com/repos/garshany/eveai/releases/latest';
const RELEASE_URL_PREFIX = 'https://github.com/garshany/eveai/releases/tag/';
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60_000;

export type UpdateStatus =
  | { kind: 'current'; current: string; latest: string; releaseUrl: string }
  | { kind: 'available'; current: string; latest: string; releaseUrl: string }
  | { kind: 'ahead'; current: string; latest: string; releaseUrl: string }
  | { kind: 'unavailable'; current: string; reason: 'offline' | 'rate_limited' | 'invalid_response' };

type UpdateCheckerDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  currentVersion?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
};

export type UpdateChecker = {
  check: (options?: { force?: boolean }) => Promise<UpdateStatus>;
};

export function createUpdateChecker(deps: UpdateCheckerDeps = {}): UpdateChecker {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const current = deps.currentVersion ?? getAppVersion();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  let cached: { at: number; value: UpdateStatus } | null = null;
  let inFlight: Promise<UpdateStatus> | null = null;

  const check = async (options: { force?: boolean } = {}): Promise<UpdateStatus> => {
    if (!options.force && cached && now() - cached.at < cacheTtlMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = requestLatest(fetchImpl, current, timeoutMs)
      .then((value) => {
        cached = { at: now(), value };
        return value;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  return { check };
}

const defaultChecker = createUpdateChecker();

export function checkForProjectUpdate(options?: { force?: boolean }): Promise<UpdateStatus> {
  return defaultChecker.check(options);
}

async function requestLatest(
  fetchImpl: typeof fetch,
  current: string,
  timeoutMs: number,
): Promise<UpdateStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(UPDATE_API_URL, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `EVEAI/${current} update-check`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status === 403 || response.status === 429) {
      return { kind: 'unavailable', current, reason: 'rate_limited' };
    }
    if (!response.ok) return { kind: 'unavailable', current, reason: 'offline' };
    const raw = await readBoundedBody(response, MAX_RESPONSE_BYTES);
    if (raw === null) return { kind: 'unavailable', current, reason: 'invalid_response' };
    return parseRelease(raw, current);
  } catch {
    return { kind: 'unavailable', current, reason: 'offline' };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string | null> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function parseRelease(raw: string, current: string): UpdateStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'unavailable', current, reason: 'invalid_response' };
  }
  if (!value || typeof value !== 'object') {
    return { kind: 'unavailable', current, reason: 'invalid_response' };
  }
  const release = value as Record<string, unknown>;
  if (release.draft !== false || release.prerelease !== false) {
    return { kind: 'unavailable', current, reason: 'invalid_response' };
  }
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const latest = tag.startsWith('v') ? tag.slice(1) : '';
  const releaseUrl = typeof release.html_url === 'string' ? release.html_url : '';
  if (!parseStableVersion(latest) || !isCanonicalReleaseUrl(releaseUrl, tag)) {
    return { kind: 'unavailable', current, reason: 'invalid_response' };
  }
  const comparison = compareStableVersions(current, latest);
  if (comparison === 0) return { kind: 'current', current, latest, releaseUrl };
  if (comparison < 0) return { kind: 'available', current, latest, releaseUrl };
  return { kind: 'ahead', current, latest, releaseUrl };
}

function isCanonicalReleaseUrl(value: string, tag: string): boolean {
  return value === `${RELEASE_URL_PREFIX}${tag}`;
}
