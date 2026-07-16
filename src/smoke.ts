import 'dotenv/config';
import { parseOptionalStrictBooleanEnv } from './config-env.js';
import { resolveOpenAiProvider } from './openai-provider.js';

type SmokeStatus = 'ok' | 'fail' | 'skip';

interface SmokeCheck {
  name: string;
  status: SmokeStatus;
  detail: string;
}

const REQUIRED_ENV_VARS = [
  'OPENAI_API_KEY',
  'EVE_CLIENT_ID',
  'EVE_CLIENT_SECRET',
  'DEFAULT_MARKET_REGION_ID',
  'DEFAULT_MARKET_REGION_NAME',
] as const;

const BOT_TOKEN_ENV_VARS = ['TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN'] as const;

const REQUEST_TIMEOUT_MS = 5_000;
const MODEL_REQUEST_TIMEOUT_MS = 30_000;

export async function runSmokeChecks(): Promise<{ ok: boolean; checks: SmokeCheck[] }> {
  const checks: SmokeCheck[] = [];

  checks.push(checkRequiredEnv());
  checks.push(await checkOpenAiResponses());
  checks.push(await checkAppHealth(resolveAppBaseUrl()));

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
  };
}

export function normalizeBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
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

function checkRequiredEnv(): SmokeCheck {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name] || !process.env[name]?.trim());
  if (missing.length > 0) {
    return {
      name: 'env',
      status: 'fail',
      detail: `Missing required env vars: ${missing.join(', ')}`,
    };
  }

  const hasBotToken = BOT_TOKEN_ENV_VARS.some((name) => Boolean(process.env[name]?.trim()));
  if (!hasBotToken) {
    return {
      name: 'env',
      status: 'fail',
      detail: `At least one bot token is required: ${BOT_TOKEN_ENV_VARS.join(' or ')}`,
    };
  }

  return {
    name: 'env',
    status: 'ok',
    detail: `Required env vars present (${REQUIRED_ENV_VARS.length} + bot token)`,
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

async function checkOpenAiResponses(): Promise<SmokeCheck> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { name: 'model_responses', status: 'skip', detail: 'OPENAI_API_KEY is not set' };
  }

  const provider = resolveOpenAiProvider();
  const baseUrl = provider.baseUrl;
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-sol';
  const storeResponses = parseOptionalStrictBooleanEnv(
    process.env,
    'OPENAI_STORE_RESPONSES',
    false,
  );
  const url = `${baseUrl}/responses`;
  if (provider.responsesTransport === 'websocket') {
    try {
      const { createNativeResponse, toNativeMessage } = await import('./agent/native-responses.js');
      const response = await createNativeResponse({
        model,
        instructions: 'Reply with the single word pong.',
        items: [toNativeMessage('ping')],
        tools: [],
        parallelToolCalls: false,
        maxOutputTokens: 32,
      });
      if (response.error || response.status !== 'completed') {
        return {
          name: 'model_responses',
          status: 'fail',
          detail: response.error?.message ?? `WebSocket response status was ${response.status ?? 'unknown'}`,
        };
      }
      const wsUrl = `${baseUrl.replace(/^https:/, 'wss:')}/responses`;
      return { name: 'model_responses', status: 'ok', detail: `${wsUrl} accepted model ${model}` };
    } catch (error) {
      return {
        name: 'model_responses',
        status: 'fail',
        detail: error instanceof Error ? error.message : 'WebSocket model check failed',
      };
    }
  }
  const payload = {
    model,
    instructions: 'Reply with the single word pong.',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'ping' }],
    }],
    stream: true,
    store: storeResponses,
  };

  const result = await fetchWithTimeout(url, {
    timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    },
  });

  if (!result.ok) {
    return { name: 'model_responses', status: 'fail', detail: result.detail };
  }
  if (!/response\.(completed|done)|output_text/.test(result.body)) {
    return {
      name: 'model_responses',
      status: 'fail',
      detail: `${url} returned HTTP 200 but did not look like a streamed Responses API result`,
    };
  }

  return { name: 'model_responses', status: 'ok', detail: `${url} accepted model ${model}` };
}

async function fetchWithTimeout(
  url: string,
  options: { timeoutMs?: number; init?: RequestInit } = {},
): Promise<{ ok: boolean; detail: string; body: string }> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options.init, signal: controller.signal });
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
        detail: `${url} timed out after ${timeoutMs}ms`,
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
