export const OPENAI_PROVIDER_IDS = ['openai', 'cheapvibecode'] as const;

export type OpenAiProviderId = typeof OPENAI_PROVIDER_IDS[number];

export type ResponsesTransport = 'http_sse' | 'websocket';
export type ToolSearchExecution = 'hosted' | 'client';

export interface OpenAiProvider {
  id: OpenAiProviderId;
  name: string;
  baseUrl: string;
  responsesTransport: ResponsesTransport;
  toolSearchExecution: ToolSearchExecution;
  supportsHostedProgrammaticToolCalling: boolean;
  supportsLocalParallelBatch: boolean;
  supportsTruncation: boolean;
  supportsEncryptedReasoningReplay: boolean;
}

const OPENAI_PROVIDERS: Record<OpenAiProviderId, OpenAiProvider> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    responsesTransport: 'http_sse',
    toolSearchExecution: 'hosted',
    supportsHostedProgrammaticToolCalling: true,
    supportsLocalParallelBatch: false,
    supportsTruncation: true,
    supportsEncryptedReasoningReplay: true,
  },
  cheapvibecode: {
    id: 'cheapvibecode',
    name: 'CheapVibeCode',
    baseUrl: 'https://cheapvibecode.ru/backend-api/codex',
    responsesTransport: 'websocket',
    toolSearchExecution: 'client',
    supportsHostedProgrammaticToolCalling: false,
    supportsLocalParallelBatch: true,
    supportsTruncation: false,
    supportsEncryptedReasoningReplay: false,
  },
};

export function resolveOpenAiProvider(
  env: Record<string, string | undefined> = process.env,
): OpenAiProvider {
  const raw = env.OPENAI_PROVIDER?.trim().toLowerCase() || 'openai';
  if (!OPENAI_PROVIDER_IDS.includes(raw as OpenAiProviderId)) {
    throw new Error(`OPENAI_PROVIDER must be one of: ${OPENAI_PROVIDER_IDS.join(', ')}`);
  }
  return OPENAI_PROVIDERS[raw as OpenAiProviderId];
}
