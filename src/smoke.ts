import 'dotenv/config';

type SmokeStatus = 'ok' | 'fail' | 'skip';

interface SmokeCheck {
  name: string;
  status: SmokeStatus;
  detail: string;
}

const REQUIRED_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'EVE_CLIENT_ID',
  'EVE_CLIENT_SECRET',
  'DEFAULT_MARKET_REGION_ID',
  'DEFAULT_MARKET_REGION_NAME',
] as const;

const REQUEST_TIMEOUT_MS = 5_000;

export async function runSmokeChecks(): Promise<{ ok: boolean; checks: SmokeCheck[] }> {
  const checks: SmokeCheck[] = [];

  checks.push(checkRequiredEnv());

  const proxyBaseUrl = normalizeBaseUrl(process.env.OPENAI_BASE_URL);
  if (proxyBaseUrl && isLocalOpenAiProxy(proxyBaseUrl)) {
    checks.push(await checkHttpOk('proxy_health', deriveProxyHealthUrl(proxyBaseUrl)));
    checks.push(await checkHttpOk('proxy_models', deriveProxyModelsUrl(proxyBaseUrl)));
  } else {
    checks.push({
      name: 'proxy_health',
      status: 'skip',
      detail: 'OPENAI_BASE_URL is not set to a local proxy URL',
    });
  }

  checks.push(await checkAppHealth(resolveAppBaseUrl()));

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
  };
}

export function normalizeBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

export function deriveProxyHealthUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = normalizedPath.endsWith('/v1')
    ? `${normalizedPath.slice(0, -3) || ''}/health`
    : `${normalizedPath || ''}/health`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function deriveProxyModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = normalizedPath.endsWith('/v1')
    ? `${normalizedPath}/models`
    : `${normalizedPath || ''}/v1/models`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function resolveAppBaseUrl(): string {
  const webBaseUrl = normalizeBaseUrl(process.env.WEB_BASE_URL);
  if (webBaseUrl) {
    return webBaseUrl;
  }

  const host = process.env.HOST?.trim() || '127.0.0.1';
  const port = process.env.PORT?.trim() || '3000';
  const safeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return `http://${safeHost}:${port}`;
}

function isLocalOpenAiProxy(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ['127.0.0.1', 'localhost', '0.0.0.0'].includes(url.hostname);
  } catch {
    return false;
  }
}

function checkRequiredEnv(): SmokeCheck {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name] || !process.env[name]?.trim());
  if (missing.length > 0) {
    return {
      name: 'env',
      status: 'fail',
      detail: `Missing required env vars: ${missing.join(', ')}`,
    };
  }

  return {
    name: 'env',
    status: 'ok',
    detail: `Required env vars present (${REQUIRED_ENV_VARS.length})`,
  };
}

async function checkAppHealth(appBaseUrl: string): Promise<SmokeCheck> {
  const url = new URL('/health', appBaseUrl).toString();
  const result = await fetchWithTimeout(url);
  if (!result.ok) {
    return {
      name: 'app_health',
      status: 'fail',
      detail: result.detail,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return {
      name: 'app_health',
      status: 'fail',
      detail: 'Health endpoint did not return JSON',
    };
  }

  const status = typeof (parsed as { status?: unknown }).status === 'string'
    ? String((parsed as { status?: unknown }).status)
    : 'unknown';
  if (status !== 'ok') {
    return {
      name: 'app_health',
      status: 'fail',
      detail: `App health is ${status}`,
    };
  }

  return {
    name: 'app_health',
    status: 'ok',
    detail: `App health OK at ${url}`,
  };
}

async function checkHttpOk(name: string, url: string): Promise<SmokeCheck> {
  const result = await fetchWithTimeout(url);
  return {
    name,
    status: result.ok ? 'ok' : 'fail',
    detail: result.detail,
  };
}

async function fetchWithTimeout(url: string): Promise<{ ok: boolean; detail: string; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        detail: `${url} returned HTTP ${response.status}`,
        body,
      };
    }
    return {
      ok: true,
      detail: `${url} returned HTTP ${response.status}`,
      body,
    };
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return {
        ok: false,
        detail: `${url} timed out after ${REQUEST_TIMEOUT_MS}ms`,
        body: '',
      };
    }
    return {
      ok: false,
      detail: `${url} failed: ${(error as Error).message}`,
      body: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

function printChecks(checks: SmokeCheck[]): void {
  for (const check of checks) {
    const prefix = check.status === 'ok' ? '[ok]' : check.status === 'skip' ? '[skip]' : '[fail]';
    console.log(`${prefix} ${check.name}: ${check.detail}`);
  }
}

async function main(): Promise<void> {
  const result = await runSmokeChecks();
  printChecks(result.checks);
  process.exit(result.ok ? 0 : 1);
}

const isMain = process.argv[1]
  ? import.meta.url === new URL(`file://${process.argv[1]}`).toString()
  : false;

if (isMain) {
  void main();
}
