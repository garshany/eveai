import { config } from '../config.js';

export type NativeInputItem =
  | NativeInputMessage
  | NativeFunctionCallOutputItem;

export type NativeInputMessage = {
  type: 'message';
  role: 'user';
  content: Array<{
    type: 'input_text';
    text: string;
  }>;
};

export type NativeFunctionCallOutputItem = {
  type: 'function_call_output';
  call_id: string;
  output: string;
};

export type NativeTool =
  | { type: 'tool_search' }
  | NativeNamespaceTool
  | NativeFunctionTool;

export type NativeNamespaceTool = {
  type: 'namespace';
  name: string;
  description: string;
  tools: NativeFunctionTool[];
};

export type NativeFunctionTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  defer_loading?: boolean;
};

export type NativeResponseOutputItem = {
  id?: string;
  type: string;
  [key: string]: unknown;
};

export type NativeResponseResult = {
  id: string | null;
  output: NativeResponseOutputItem[];
  outputText: string;
  error: { message: string } | null;
  toolSearchPaths: string[];
  rawEvents: NativeSseEvent[];
};

type NativeSseEvent = {
  event: string;
  data: unknown;
};

type NativeResponseEnvelope = {
  id?: string;
  error?: { message?: string } | null;
  output?: NativeResponseOutputItem[];
  output_text?: string;
};

export async function createNativeResponse(input: {
  instructions: string;
  items: NativeInputItem[];
  tools: NativeTool[];
  model?: string;
  previousResponseId?: string | null;
  parallelToolCalls?: boolean;
}): Promise<NativeResponseResult> {
  const baseUrl = normalizeBaseUrl(config.openai.baseUrl);
  const bodyPayload = {
      model: input.model ?? config.openai.model,
      instructions: input.instructions,
      input: input.items,
      previous_response_id: input.previousResponseId ?? undefined,
      tools: input.tools,
      tool_choice: 'auto',
      parallel_tool_calls: input.parallelToolCalls ?? false,
      reasoning: config.openai.reasoningEffort
        ? { effort: config.openai.reasoningEffort }
        : undefined,
      store: false,
      stream: true,
      include: [],
    };
  const bodyJson = JSON.stringify(bodyPayload);
  console.log('[api] POST %s/responses — payload %d chars, %d tools, %d input items, prevId=%s',
    baseUrl, bodyJson.length, input.tools.length, input.items.length,
    input.previousResponseId ?? 'none');
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.openai.apiKey}`,
    },
    body: bodyJson,
  });

  const rawText = await response.text();
  if (!response.ok) {
    const detail = extractErrorMessage(rawText) ?? `HTTP ${response.status}`;
    throw new Error(detail);
  }

  const events = parseSse(rawText);
  const completedPayload = findCompletedPayload(events);
  const doneItems = collectDoneItems(events);
  const output = completedPayload?.output ?? doneItems;
  const outputText = completedPayload?.output_text ?? extractOutputText(output);
  const errorMessage = completedPayload?.error?.message
    ?? findStreamError(events)
    ?? null;

  const toolSearchPaths = extractToolSearchPaths(output);

  // Debug: log usage and tool_search activity
  const usage = (completedPayload as Record<string, unknown> | null)?.usage as Record<string, unknown> | undefined;
  if (usage) {
    console.log('[usage] input=%s output=%s total=%s cached=%s reasoning=%s',
      usage.input_tokens ?? '?', usage.output_tokens ?? '?', usage.total_tokens ?? '?',
      (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? '0',
      (usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens ?? '0');
  }

  const toolSearchItems = output.filter((item) => item.type === 'tool_search_output');
  if (toolSearchItems.length > 0) {
    console.log('[tool_search] paths: %j', toolSearchPaths);
  }

  const fnCalls = output.filter((item) => item.type === 'function_call');
  if (fnCalls.length > 0) {
    console.log('[calls] %s', fnCalls.map((c) => c.name).join(', '));
  }

  return {
    id: completedPayload?.id ?? null,
    output,
    outputText,
    error: errorMessage ? { message: errorMessage } : null,
    toolSearchPaths,
    rawEvents: events,
  };
}

export function toNativeMessage(text: string): NativeInputMessage {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

export function buildFunctionCallOutputs(
  results: Array<{ callId: string; output: string }>,
): NativeFunctionCallOutputItem[] {
  return results.map((entry) => ({
    type: 'function_call_output',
    call_id: entry.callId,
    output: entry.output,
  }));
}

export function extractFunctionCalls(
  output: NativeResponseOutputItem[],
): Array<{ callId: string; name: string; argumentsText: string }> {
  return output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      callId: String(item.call_id ?? item.id ?? ''),
      name: String(item.name ?? ''),
      argumentsText: String(item.arguments ?? '{}'),
    }))
    .filter((item) => item.callId && item.name);
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  if (!trimmed) return 'https://api.openai.com/v1';
  return trimmed;
}

function parseSse(raw: string): NativeSseEvent[] {
  const chunks = raw
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const events: NativeSseEvent[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message';
    const dataLine = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
    if (!dataLine || dataLine === '[DONE]') continue;
    let data: unknown = dataLine;
    try {
      data = JSON.parse(dataLine);
    } catch {
      data = dataLine;
    }
    events.push({ event, data });
  }
  return events;
}

function collectDoneItems(events: NativeSseEvent[]): NativeResponseOutputItem[] {
  const output: NativeResponseOutputItem[] = [];
  for (const event of events) {
    if (event.event !== 'response.output_item.done') continue;
    const item = (event.data as { item?: NativeResponseOutputItem } | null)?.item;
    if (item && typeof item === 'object' && typeof item.type === 'string') {
      output.push(item);
    }
  }
  return output;
}

function findCompletedPayload(events: NativeSseEvent[]): NativeResponseEnvelope | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event !== 'response.completed') continue;
    const data = event.data as { response?: NativeResponseEnvelope } | NativeResponseEnvelope | null;
    if (!data || typeof data !== 'object') continue;
    if ('response' in data && data.response && typeof data.response === 'object') {
      return data.response;
    }
    return data as NativeResponseEnvelope;
  }
  return null;
}

function findStreamError(events: NativeSseEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event !== 'response.error') continue;
    const data = event.data as { error?: { message?: string } } | null;
    const message = data?.error?.message;
    if (typeof message === 'string' && message) return message;
  }
  return null;
}

function extractOutputText(items: NativeResponseOutputItem[]): string {
  const chunks: string[] = [];
  for (const item of items) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as Array<Record<string, unknown>>) {
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          chunks.push(part.text);
        }
      }
    }
    if (item.type === 'output_text' && typeof item.text === 'string') {
      chunks.push(item.text);
    }
  }
  return chunks.join('\n').trim();
}

export function extractToolSearchPaths(items: NativeResponseOutputItem[]): string[] {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.type !== 'tool_search_output') continue;
    const directPaths = Array.isArray(item.paths) ? item.paths : [];
    const toolEntries = Array.isArray(item.tools) ? item.tools : [];
    const nestedPaths = Array.isArray((item.output as { paths?: unknown[] } | undefined)?.paths)
      ? ((item.output as { paths?: unknown[] }).paths ?? [])
      : [];
    for (const path of [...directPaths, ...nestedPaths]) {
      if (typeof path === 'string' && path.trim()) paths.add(path.trim());
    }
    for (const tool of toolEntries) {
      collectToolSearchNames(tool, paths);
    }
  }
  return [...paths];
}

function collectToolSearchNames(value: unknown, paths: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.name === 'string' && record.name.trim()) {
    paths.add(record.name.trim());
  }
  if (Array.isArray(record.paths)) {
    for (const path of record.paths) {
      if (typeof path === 'string' && path.trim()) {
        paths.add(path.trim());
      }
    }
  }
  if (Array.isArray(record.tools)) {
    for (const entry of record.tools) {
      collectToolSearchNames(entry, paths);
    }
  }
}

function extractErrorMessage(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { detail?: string; error?: { message?: string } };
    return parsed.detail ?? parsed.error?.message ?? null;
  } catch {
    return raw.trim() || null;
  }
}
