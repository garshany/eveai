export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  const signal = timeoutSignal(timeoutMs, init.signal);
  return fetch(input, {
    ...init,
    signal,
  });
}

export function timeoutSignal(timeoutMs: number, parentSignal?: AbortSignal | null): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) {
    return timeoutSignal;
  }
  return AbortSignal.any([parentSignal, timeoutSignal]);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Retry-aware fetch — shared by all non-ESI external API clients.
// Retries on network errors, 429, and 5xx with exponential backoff + jitter.
// Respects Retry-After header when present.
// ---------------------------------------------------------------------------

export type RetryConfig = {
  maxAttempts: number;
  backoffMaxMs: number;
  timeoutMs: number;
};

export async function fetchRetrying(
  input: RequestInfo | URL,
  init: RequestInit,
  opts: RetryConfig,
): Promise<Response> {
  const { maxAttempts, backoffMaxMs, timeoutMs } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      const signal = timeoutSignal(timeoutMs, init.signal);
      response = await fetch(input, { ...init, signal });
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      await sleep(retryBackoffMs(null, attempt, backoffMaxMs));
      continue;
    }

    if (response.ok || response.status === 304) return response;

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxAttempts) {
      await sleep(retryBackoffMs(response.headers, attempt, backoffMaxMs));
      continue;
    }

    return response;
  }

  throw new Error('fetchRetrying: exhausted all retry attempts');
}

function retryBackoffMs(headers: Headers | null, attempt: number, maxMs: number): number {
  const retryAfterMs = headers ? parseRetryAfterMs(headers.get('retry-after'), 0) : 0;
  const exponentialMs = Math.min(maxMs, 1000 * (2 ** (attempt - 1)));
  const baseMs = Math.max(exponentialMs, retryAfterMs);
  const jitterMs = Math.min(250, baseMs / 4);
  return Math.min(maxMs, Math.round(baseMs + Math.random() * jitterMs));
}

// ---------------------------------------------------------------------------
// Retry-After / header utilities
// ---------------------------------------------------------------------------

export function parseRetryAfterMs(value: string | null, defaultMs: number): number {
  if (!value) return defaultMs;

  const numericSeconds = Number(value);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.max(0, numericSeconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return defaultMs;
}

export function parseHeaderInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}
