import 'dotenv/config';
import {
  parseOptionalEnumEnv,
  parseOptionalStrictBooleanEnv,
} from '../src/config-env.js';
import {
  REASONING_EFFORTS,
  REASONING_MODES,
  TEXT_VERBOSITIES,
  toApiReasoningEffort,
} from '../src/openai-options.js';
import { validateOpenAiSmokeCompletion } from '../src/openai-smoke-validation.js';
import { resolveOpenAiProvider } from '../src/openai-provider.js';
import { createNativeResponse, toNativeMessage } from '../src/agent/native-responses.js';

const provider = resolveOpenAiProvider();
const baseUrl = provider.baseUrl;
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
const storeResponses = parseOptionalStrictBooleanEnv(
  process.env,
  'OPENAI_STORE_RESPONSES',
  false,
);
const expectedText = 'eveai-openai-smoke-ok';

if (!apiKey) {
  fail('OPENAI_API_KEY is required for authenticated OpenAI smoke test.');
}

try {
  const response = await createNativeResponse({
    model,
    instructions: 'You are a smoke-test responder. Return only the requested literal text.',
    items: [toNativeMessage(`Reply with exactly: ${expectedText}`)],
    tools: [],
    parallelToolCalls: false,
    reasoningEffort: configuredReasoningEffort,
    reasoningMode,
    textVerbosity,
    maxOutputTokens: 128,
  });
  if (response.error || response.status !== 'completed') {
    fail(response.error?.message ?? `Responses API completed with status ${response.status ?? 'unknown'}`);
  }
  const validated = validateOpenAiSmokeCompletion(
    {
      id: response.id,
      model,
      output_text: response.outputText,
      output: response.output,
    },
    response.outputText,
    expectedText,
  );

  console.log(JSON.stringify({
    ok: true,
    provider: provider.id,
    endpoint: provider.responsesTransport === 'websocket'
      ? `${baseUrl.replace(/^https:/, 'wss:')}/responses`
      : `${baseUrl}/responses`,
    transport: provider.responsesTransport,
    model: validated.model ?? model,
    reasoning_effort: reasoningEffort,
    reasoning_mode: reasoningMode,
    stored_response: storeResponses,
    response_id_prefix: validated.id ? validated.id.slice(0, 12) : null,
    text_preview: validated.text,
  }, null, 2));
} catch (error) {
  fail((error as Error).message);
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
