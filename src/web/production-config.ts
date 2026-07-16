export type PublicWebProductionConfig = {
  nodeEnv: string | undefined;
  chatEnabled: boolean;
  baseUrl: string;
  trustedProxyCidrs: readonly string[];
  turnstileSecretKey: string;
  turnstileHostname: string;
};

/** Return startup-blocking errors for a public production web deployment. */
export function validatePublicWebProductionConfig(input: PublicWebProductionConfig): string[] {
  if (input.nodeEnv !== 'production' || !input.chatEnabled) return [];

  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    return ['WEB_BASE_URL должен быть корректным абсолютным URL.'];
  }

  const publicOrigin = !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!publicOrigin) return [];

  const errors: string[] = [];
  if (url.protocol !== 'https:') {
    errors.push('Публичный WEB_BASE_URL в production должен использовать HTTPS.');
  }
  if (input.trustedProxyCidrs.length === 0) {
    errors.push('Для публичного web origin задай явный WEB_TRUSTED_PROXY_CIDRS; trust-all запрещён.');
  }
  if (!input.turnstileSecretKey) {
    errors.push('Для публичного web origin включи Cloudflare Turnstile с обязательным Siteverify.');
  }
  if (!input.turnstileHostname) {
    errors.push('Для публичного web origin задай TURNSTILE_EXPECTED_HOSTNAME.');
  }
  return errors;
}
