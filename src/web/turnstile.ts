import { config } from '../config.js';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5_000;
const VERIFY_MAX_ATTEMPTS = 2;
const VERIFY_RETRY_DELAY_MS = 250;
const MAX_TOKEN_LENGTH = 2_048;
const MAX_CHALLENGE_AGE_MS = 5 * 60_000;

type SiteverifyPayload = {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  challenge_ts?: unknown;
  'error-codes'?: unknown;
};

export type TurnstileVerification =
  | { ok: true }
  | { ok: false; retryable: boolean };

export function isTurnstileEnabled(): boolean {
  return Boolean(config.web.turnstileSiteKey && config.web.turnstileSecretKey);
}

export async function verifyTurnstileToken(
  token: unknown,
  remoteIp: string,
  expectedAction: 'session',
): Promise<TurnstileVerification> {
  if (!isTurnstileEnabled()) return { ok: true };
  if (typeof token !== 'string' || token.length < 10 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, retryable: false };
  }

  let last: TurnstileVerification = { ok: false, retryable: true };
  for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt += 1) {
    last = await requestSiteverify(token, remoteIp, expectedAction);
    if (last.ok || !last.retryable) return last;
    if (attempt < VERIFY_MAX_ATTEMPTS) await delay(VERIFY_RETRY_DELAY_MS);
  }
  return last;
}

async function requestSiteverify(
  token: string,
  remoteIp: string,
  expectedAction: 'session',
): Promise<TurnstileVerification> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      secret: config.web.turnstileSecretKey,
      response: token,
      remoteip: remoteIp,
    });
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, retryable: response.status === 429 || response.status >= 500 };
    }
    const payload = await response.json().catch(() => null) as SiteverifyPayload | null;
    if (!payload) return { ok: false, retryable: true };
    if (payload.success !== true) return { ok: false, retryable: isInternalSiteverifyError(payload) };
    if (payload.action !== expectedAction) return { ok: false, retryable: false };
    if (
      config.web.turnstileHostname
      && payload.hostname !== config.web.turnstileHostname
    ) return { ok: false, retryable: false };
    if (typeof payload.challenge_ts !== 'string') return { ok: false, retryable: false };
    const challengeAt = Date.parse(payload.challenge_ts);
    if (!Number.isFinite(challengeAt) || Math.abs(Date.now() - challengeAt) > MAX_CHALLENGE_AGE_MS) {
      return { ok: false, retryable: false };
    }
    return { ok: true };
  } catch {
    return { ok: false, retryable: true };
  } finally {
    clearTimeout(timeout);
  }
}

function isInternalSiteverifyError(payload: SiteverifyPayload): boolean {
  const codes = payload['error-codes'];
  return Array.isArray(codes) && codes.includes('internal-error');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
