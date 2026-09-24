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

/**
 * Browser EVE logins are bound to the web session cookie, which is host-scoped:
 * the SSO callback only sees it when EVE_CALLBACK_URL is on the same host as
 * the web app. Returns a warning when they differ (every browser login would
 * then end in ?auth=error), or null when the hosts match or cannot be parsed.
 */
export function browserSsoCallbackHostWarning(callbackUrl: string, webBaseUrl: string): string | null {
  let callbackHost: string;
  let webHost: string;
  try {
    callbackHost = new URL(callbackUrl).host;
    webHost = new URL(webBaseUrl).host;
  } catch {
    return null;
  }
  if (callbackHost === webHost) return null;
  return `EVE_CALLBACK_URL (${callbackHost}) и WEB_BASE_URL (${webHost}) на разных хостах — `
    + 'веб-вход через EVE SSO будет отклонён: cookie веб-сессии не дойдёт до callback. Укажи один хост.';
}
