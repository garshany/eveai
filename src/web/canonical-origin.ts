const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function buildCanonicalLoopbackUrl(
  baseUrl: string,
  requestUrl: string,
  protocol: string,
  hostHeader: string | undefined,
): string | null {
  if (!hostHeader) return null;

  try {
    const canonical = new URL(baseUrl);
    const requested = new URL(requestUrl, `${protocol}://${hostHeader}`);
    if (requested.origin === canonical.origin) return null;
    if (!LOOPBACK_HOSTS.has(requested.hostname) || !LOOPBACK_HOSTS.has(canonical.hostname)) return null;
    if (requested.protocol !== canonical.protocol || effectivePort(requested) !== effectivePort(canonical)) return null;

    return new URL(`${requested.pathname}${requested.search}`, `${canonical.origin}/`).toString();
  } catch {
    return null;
  }
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === 'http:') return '80';
  if (url.protocol === 'https:') return '443';
  return '';
}
