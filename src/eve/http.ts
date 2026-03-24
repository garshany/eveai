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
