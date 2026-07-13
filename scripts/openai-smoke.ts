import 'dotenv/config';
import { parseOptionalEnumEnv, parseOptionalPositiveIntEnv } from '../src/config-env.js';
import {
  REASONING_EFFORTS,
  REASONING_MODES,
  TEXT_VERBOSITIES,
  toApiReasoningEffort,
} from '../src/openai-options.js';
import { validateOpenAiSmokeCompletion } from '../src/openai-smoke-validation.js';

const baseUrl = 'https://api.openai.com/v1';
const apiKey = process.env.OPENAI_API_KEY || '';
const model = process.env.OPENAI_MODEL || 'gpt-5.6-sol';
const configuredReasoningEffort = parseOptionalEnumEnv(
  process.env,
  'OPENAI_REASONING_EFFORT',
  REASONING_EFFORTS,
  'auto',
);
const reasoningEffort = toApiReasoningEffort(configuredReasoningEffort);
const reasoningMode = parseOptionalEnumEnv(
  process.env,
  'OPENAI_REASONING_MODE',
  REASONING_MODES,
  'standard',
);
const textVerbosity = parseOptionalEnumEnv(
  process.env,
  'OPENAI_TEXT_VERBOSITY',
  TEXT_VERBOSITIES,
  'low',
);
const responsesTimeoutMs = parseOptionalPositiveIntEnv(
  process.env,
  'OPENAI_RESPONSES_TIMEOUT_MS',
  90000,
);
const timeoutMs = parseOptionalPositiveIntEnv(
  process.env,
  'OPENAI_SMOKE_TIMEOUT_MS',
  responsesTimeoutMs,
);
const expectedText = 'eveai-openai-smoke-ok';

if (!apiKey) {
  fail('OPENAI_API_KEY is required for authenticated OpenAI smoke test.');
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

const payload: Record<string, unknown> = {
  model,
  instructions: 'You are a smoke-test responder. Return only the requested literal text.',
  input: [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: `Reply with exactly: ${expectedText}` }],
  }],
  tools: [],
  tool_choice: 'auto',
  parallel_tool_calls: false,
  reasoning: {
    effort: reasoningEffort,
    ...(reasoningMode === 'pro' ? { mode: 'pro' } : {}),
  },
  text: textVerbosity ? { verbosity: textVerbosity } : undefined,
  store: false,
  stream: true,
};

try {
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  if (!response.ok) {
    fail(`Responses API HTTP ${response.status}: ${extractErrorMessage(raw)}`);
  }

  const events = parseSse(raw);
  const completed = findCompletedResponse(events);
  const validated = validateOpenAiSmokeCompletion(
    completed,
    extractStreamText(events),
    expectedText,
  );

  console.log(JSON.stringify({
    ok: true,
    endpoint: `${baseUrl}/responses`,
    model: validated.model ?? model,
    reasoning_effort: reasoningEffort,
    reasoning_mode: reasoningMode,
    response_id_prefix: validated.id ? validated.id.slice(0, 12) : null,
    text_preview: validated.text,
  }, null, 2));
} catch (error) {
  if ((error as Error).name === 'AbortError') {
    fail(`Responses API timed out after ${Math.round(timeoutMs / 1000)}s.`);
  }
  fail((error as Error).message);
} finally {
  clearTimeout(timer);
}

function fail(message: string): never {
  console.error(JSON.stringify({ ok: false, error: sanitize(message) }, null, 2));
  process.exit(1);
}

function sanitize(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '[TOKEN_REDACTED]')
    .replace(/sk-[A-Za-z0-9._-]{12,}/g, '[OPENAI_KEY_REDACTED]');
}

function extractErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { detail?: string; error?: { message?: string } };
    return sanitize(parsed.detail ?? parsed.error?.message ?? raw.slice(0, 500));
  } catch {
    return sanitize(raw.slice(0, 500));
  }
}

type SseEvent = { event: string; data: unknown };

function parseSse(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  let currentEvent = 'message';
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length === 0) {
      currentEvent = 'message';
      return;
    }
    const dataText = dataLines.join('\n');
    dataLines = [];
    if (!dataText || dataText === '[DONE]') {
      currentEvent = 'message';
      return;
    }
    let data: unknown = dataText;
    try { data = JSON.parse(dataText); } catch {}
    let event = currentEvent;
    if (event === 'message' && data && typeof data === 'object') {
      const type = (data as { type?: unknown }).type;
      if (typeof type === 'string' && type) event = type;
    }
    events.push({ event, data });
    currentEvent = 'message';
  };
  for (const line of raw.split(/\r?\n/)) {
    if (line === '') { flush(); continue; }
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) { currentEvent = line.slice(6).trim() || 'message'; continue; }
    if (line.startsWith('data:')) { dataLines.push(line.slice(5).replace(/^\s/, '')); continue; }
  }
  flush();
  return events;
}

function findCompletedResponse(events: SseEvent[]): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.event !== 'response.completed' && event.event !== 'response.done') continue;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') continue;
    const response = data.response;
    return response && typeof response === 'object' ? response as Record<string, unknown> : data;
  }
  return null;
}

function extractStreamText(events: SseEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.event !== 'response.output_text.delta') continue;
    const data = event.data as Record<string, unknown> | null;
    if (typeof data?.delta === 'string') chunks.push(data.delta);
  }
  return chunks.join('').trim();
}
