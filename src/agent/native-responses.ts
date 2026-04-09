import { config } from '../config.js';

export type NativeInputItem =
  | NativeInputMessage
  | NativeFunctionCallOutputItem;

export type NativeInputMessage = {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{
    type: 'input_text' | 'output_text';
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

export type NativeUsage = {
  input: number;
  output: number;
  total: number;
  cached: number;
  reasoning: number;
};

export type NativeResponseResult = {
  id: string | null;
  output: NativeResponseOutputItem[];
  outputText: string;
  error: { message: string } | null;
  toolSearchPaths: string[];
  rawEvents: NativeSseEvent[];
  usage: NativeUsage | null;
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

const RESPONSES_TIMEOUT_MS = 90_000;

export async function createNativeResponse(input: {
  instructions: string;
  items: NativeInputItem[];
  tools: NativeTool[];
  model?: string;
  previousResponseId?: string | null;
  promptCacheKey?: string;
  parallelToolCalls?: boolean;
  truncation?: string;
  contextManagement?: Array<{ type: string; compact_threshold: number }>;
  chatId?: number;
}): Promise<NativeResponseResult> {
  const baseUrl = normalizeBaseUrl(config.openai.baseUrl);
  const bodyPayload: Record<string, unknown> = {
      model: input.model ?? config.openai.model,
      instructions: input.instructions,
      input: input.items,
      previous_response_id: input.previousResponseId ?? undefined,
      prompt_cache_key: input.promptCacheKey ?? undefined,
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
  if (input.truncation) {
    bodyPayload.truncation = input.truncation;
  }
  if (input.contextManagement) {
    bodyPayload.context_management = input.contextManagement;
  }
  const bodyJson = JSON.stringify(bodyPayload);
  console.log('[api] POST %s/responses — payload %d chars, %d tools, %d input items, prevId=%s',
    baseUrl, bodyJson.length, input.tools.length, input.items.length,
    input.previousResponseId ?? 'none');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESPONSES_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.openai.apiKey}`,
        ...(input.chatId ? { 'x-chat-id': String(input.chatId) } : {}),
      },
      body: bodyJson,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`Responses API timed out after ${Math.round(RESPONSES_TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text();
  if (!response.ok) {
    const detail = extractErrorMessage(rawText) ?? `HTTP ${response.status}`;
    throw new Error(detail);
  }

  const events = parseSse(rawText);
  const completedPayload = findCompletedPayload(events);
  const doneItems = collectDoneItems(events);
  const completedOutput = Array.isArray(completedPayload?.output)
    ? completedPayload.output
    : null;
  let output = completedOutput && completedOutput.length > 0
    ? completedOutput
    : doneItems;
  if (output.length === 0) {
    output = reconstructFunctionCallsFromStream(events);
    if (output.length > 0) {
      console.log('[api] reconstructed %d function call(s) from stream events', output.length);
    }
  }
  const outputTextFromItems = extractOutputText(output);
  const outputTextFromStream = extractStreamedOutputText(events);
  const outputText = completedPayload?.output_text
    ?? (outputTextFromStream || outputTextFromItems);
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
    usage: usage ? {
      input: Number(usage.input_tokens ?? 0),
      output: Number(usage.output_tokens ?? 0),
      total: Number(usage.total_tokens ?? 0),
      cached: Number((usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? 0),
      reasoning: Number((usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens ?? 0),
    } : null,
  };
}

export function toNativeMessage(text: string): NativeInputMessage {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

export function toNativeAssistantMessage(text: string): NativeInputMessage {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
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
  const events: NativeSseEvent[] = [];
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
    try {
      data = JSON.parse(dataText);
    } catch {
      data = dataText;
    }
    let event = currentEvent;
    if (event === 'message' && data && typeof data === 'object') {
      const dataType = (data as { type?: unknown }).type;
      if (typeof dataType === 'string' && dataType.trim()) {
        event = dataType.trim();
      }
    }
    events.push({ event, data });
    currentEvent = 'message';
  };

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim() || 'message';
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^\s/, ''));
      continue;
    }
    if (line.startsWith('id:') || line.startsWith('retry:')) {
      continue;
    }
    dataLines.push(line);
  }
  flush();
  return events;
}

function isOutputTextDelta(event: string): boolean {
  return event === 'response.output_text.delta' || event === 'response.text.delta';
}

function isOutputTextDone(event: string): boolean {
  return event === 'response.output_text.done' || event === 'response.text.done';
}

function extractStreamedOutputText(events: NativeSseEvent[]): string {
  const chunks: string[] = [];
  let doneText = '';
  let sawDelta = false;
  for (const event of events) {
    if (!isOutputTextDelta(event.event) && !isOutputTextDone(event.event)) continue;
    const data = event.data as Record<string, unknown> | null;
    const delta = typeof data?.delta === 'string' ? data.delta : null;
    const text = typeof data?.text === 'string' ? data.text : null;
    const outputText = typeof data?.output_text === 'string' ? data.output_text : null;
    const nestedText = typeof (data?.output_text as { text?: unknown } | undefined)?.text === 'string'
      ? (data?.output_text as { text?: string }).text
      : null;
    if (isOutputTextDelta(event.event)) {
      const token = delta ?? text ?? outputText ?? nestedText;
      if (typeof token === 'string' && token) {
        sawDelta = true;
        chunks.push(token);
      }
      continue;
    }
    if (isOutputTextDone(event.event)) {
      const finalText = text ?? outputText ?? nestedText ?? delta;
      if (typeof finalText === 'string' && finalText) {
        doneText = finalText;
      }
    }
  }
  if (sawDelta) return chunks.join('').trim();
  return doneText.trim();
}

function collectDoneItems(events: NativeSseEvent[]): NativeResponseOutputItem[] {
  const output: NativeResponseOutputItem[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (
      event.event !== 'response.output_item.done'
      && event.event !== 'response.function_call_arguments.done'
    ) {
      continue;
    }
    const data = event.data as {
      item?: NativeResponseOutputItem;
      output_item?: NativeResponseOutputItem;
    } | null;
    const item = data?.item ?? data?.output_item ?? null;
    if (item && typeof item === 'object' && typeof item.type === 'string') {
      const key = String(item.call_id ?? item.id ?? `${item.type}:${output.length}`);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(item);
    }
  }
  return output;
}

function findCompletedPayload(events: NativeSseEvent[]): NativeResponseEnvelope | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event !== 'response.completed' && event.event !== 'response.done') continue;
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
    if (event.event === 'error' || event.event === 'response.error' || event.event === 'response.failed') {
      const data = event.data as Record<string, unknown> | null;
      console.log('[api] stream error event=%s data=%s', event.event, JSON.stringify(data)?.slice(0, 500));
      const message = (data?.error as Record<string, unknown> | undefined)?.message
        ?? (data as Record<string, unknown> | undefined)?.message
        ?? (data?.error as Record<string, unknown> | undefined)?.code;
      if (typeof message === 'string' && message) return message;
      return `API error: ${event.event} ${JSON.stringify(data)?.slice(0, 200)}`;
    }
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
    const output = item.output as Record<string, unknown> | undefined;
    const toolEntries = [
      ...(Array.isArray(item.tools) ? item.tools : []),
      ...(Array.isArray(output?.tools) ? (output?.tools as unknown[]) : []),
    ];
    const nestedPaths = Array.isArray((output as { paths?: unknown[] } | undefined)?.paths)
      ? ((output as { paths?: unknown[] }).paths ?? [])
      : [];
    for (const path of [...directPaths, ...nestedPaths]) {
      if (typeof path === 'string' && path.trim()) paths.add(path.trim());
    }
    if (output) collectToolSearchNames(output, paths);
    for (const tool of toolEntries) {
      collectToolSearchNames(tool, paths);
    }
  }
  return [...paths];
}

export const __test__ = {
  parseSse,
  extractStreamedOutputText,
  collectDoneItems,
  findCompletedPayload,
  RESPONSES_TIMEOUT_MS,
};

function reconstructFunctionCallsFromStream(events: NativeSseEvent[]): NativeResponseOutputItem[] {
  const partials = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const data = event.data as Record<string, unknown> | null;
    if (!data) continue;
    if (event.event === 'response.output_item.added' || event.event === 'response.output_item.done') {
      const item = (data.item ?? data.output_item) as Record<string, unknown> | undefined;
      const candidate = item?.type === 'function_call' ? item : null;
      if (candidate?.call_id) {
        const callId = String(candidate.call_id);
        const existing = partials.get(callId) ?? {};
        partials.set(callId, { ...existing, ...candidate, type: 'function_call' });
      }
    }
    if (event.event === 'response.function_call_arguments.done' && data.call_id) {
      const callId = String(data.call_id);
      const existing = partials.get(callId) ?? {};
      partials.set(callId, {
        ...existing,
        type: 'function_call',
        call_id: callId,
        arguments: String(data.arguments ?? existing.arguments ?? '{}'),
        name: existing.name ?? data.name,
        id: existing.id ?? data.item_id ?? callId,
      });
    }
  }
  return [...partials.values()]
    .filter((p) => p.name && p.call_id)
    .map((p) => p as NativeResponseOutputItem);
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
