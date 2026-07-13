import type { FastifyInstance } from 'fastify';

export interface SecurityHeadersOptions {
  baseUrl: string;
}

export function registerSecurityHeaders(app: FastifyInstance, options: SecurityHeadersOptions): void {
  app.addHook('onSend', async (req, reply, payload) => {
    const headers = buildSecurityHeaders(options, req.headers);
    for (const [name, value] of Object.entries(headers)) {
      if (reply.getHeader(name) === undefined) {
        reply.header(name, value);
      }
    }

    return payload;
  });
}

export function buildSecurityHeaders(
  options: SecurityHeadersOptions,
  requestHeaders?: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const baseOrigin = getOrigin(options.baseUrl);
  const formActionSources = ["'self'"];
  const connectSources = ["'self'"];

  if (baseOrigin) {
    formActionSources.push(baseOrigin);
    connectSources.push(baseOrigin);
  }

  const headers: Record<string, string> = {
    'Content-Security-Policy': buildContentSecurityPolicy(formActionSources, connectSources),
    'Permissions-Policy': [
      'accelerometer=()',
      'camera=()',
      'geolocation=()',
      'gyroscope=()',
      'microphone=()',
      'payment=()',
      'usb=()',
    ].join(', '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Permitted-Cross-Domain-Policies': 'none',
  };

  if (isSecureRequest(options.baseUrl, requestHeaders)) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }

  return headers;
}

export function buildContentSecurityPolicy(formActionSources: string[], connectSources: string[]): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    `form-action ${formActionSources.join(' ')}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "frame-src 'none'",
    "font-src 'self'",
    "manifest-src 'self'",
    "media-src 'none'",
    "worker-src 'self'",
  ].join('; ');
}

function getOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isSecureRequest(baseUrl: string, requestHeaders?: Record<string, string | string[] | undefined>): boolean {
  try {
    if (new URL(baseUrl).protocol === 'https:') {
      return true;
    }
  } catch {
    // ignore invalid base URL
  }

  const forwardedProto = requestHeaders?.['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return typeof proto === 'string' && proto.split(',').some((value) => value.trim() === 'https');
}
