import { config } from '../config.js';
import {
  toApiReasoningEffort,
  type ReasoningEffort,
  type ReasoningMode,
  type TextVerbosity,
} from '../openai-options.js';
import { getActivitySink, reportActivity } from './activity.js';
import { ResponseAdmissionController } from './response-admission.js';

let responseAdmission: ResponseAdmissionController | null = null;

function getResponseAdmission(): ResponseAdmissionController {
  responseAdmission ??= new ResponseAdmissionController({
    maxConcurrent: config.openai?.maxConcurrentResponses ?? 8,
    maxQueued: config.openai?.maxQueuedResponses ?? 32,
    queueTimeoutMs: config.openai?.responseQueueTimeoutMs ?? 15_000,
  });
  return responseAdmission;
}

export type NativeInputItem =
  | NativeInputMessage
  | NativeReasoningItem
  | NativeProgramItem
  | NativeProgramOutputItem
  | NativeFunctionCallItem
  | NativeFunctionCallOutputItem
  | NativeResponseOutputItem;

export type NativeInputMessage = {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{
    type: 'input_text' | 'output_text';
    text: string;
  }>;
};

export type NativeReasoningItem = {
  type: 'reasoning';
  id?: string;
  encrypted_content?: string | null;
  summary?: unknown[];
  [key: string]: unknown;
};

export type NativeProgramItem = {
  type: 'program';
  id?: string;
  call_id?: string;
  code?: string;
  fingerprint?: unknown;
  [key: string]: unknown;
};

export type NativeProgramOutputItem = {
  type: 'program_output';
  id?: string;
  call_id?: string;
  result?: unknown;
  status?: string;
  [key: string]: unknown;
};

export type NativeFunctionCallItem = {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  id?: string;
  status?: string;
  caller?: NativeFunctionCaller;
  [key: string]: unknown;
};

export type NativeFunctionCallOutputItem = {
  type: 'function_call_output';
  call_id: string;
  output: string;
  caller?: NativeFunctionCaller;
  [key: string]: unknown;
};

export type NativeToolSearchOutputItem = {
  type: 'tool_search_output';
  call_id: string;
  status: 'completed';
  execution: 'client';
  tools: NativeTool[];
};

export type NativeFunctionCaller = {
  type: 'program';
  caller_id: string;
};

export type NativeTool =
  | {
    type: 'tool_search';
    execution?: 'client' | 'server';
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  }
  | { type: 'programmatic_tool_calling' }
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
  allowed_callers?: Array<'direct' | 'programmatic'>;
  output_schema?: Record<string, unknown>;
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
  cacheWrite?: number;
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
  status: string | null;
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
  status?: string;
};

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
  textVerbosity?: TextVerbosity;
  reasoningEffort?: ReasoningEffort;
  reasoningMode?: ReasoningMode;
  safetyIdentifier?: string;
  maxOutputTokens?: number;
  preserveReasoning?: boolean;
  /**
   * When true (the top-level agent loop only), stream output/reasoning to an
   * attached activity sink. Internal calls — compaction, OSINT, route advisor —
   * leave this false so their text never leaks into the CLI answer stream.
   */
  streamToActivity?: boolean;
  signal?: AbortSignal;
}): Promise<NativeResponseResult> {
  const baseUrl = normalizeBaseUrl(config.openai.baseUrl);
  const effectiveEffort = toApiReasoningEffort(input.reasoningEffort ?? config.openai.reasoningEffort);
  const effectiveMode = input.reasoningMode ?? 'standard';
  const maxTokens = input.maxOutputTokens || config.openai.maxOutputTokens || 0;
  const textVerbosity = input.textVerbosity ?? config.openai.textVerbosity;
  const timeoutMs = config.openai.responsesTimeoutMs;
  // Ask for a concise reasoning summary only for the top-level agent turn with an
  // activity sink attached (the interactive CLI) so it can show a "thinking" line.
  // Bots (no sink) and internal calls (compaction/OSINT/advisor, streamToActivity
  // false) get an unchanged request — no extra summary tokens, no leaked text.
  const activitySink = getActivitySink();
  const streamThisCall = input.streamToActivity === true && activitySink !== undefined;
  const wantReasoningSummary = streamThisCall && activitySink.reasoning !== false;
  const reasoningPayload: Record<string, unknown> = { effort: effectiveEffort };
  if (effectiveMode === 'pro') reasoningPayload.mode = 'pro';
  if (wantReasoningSummary) reasoningPayload.summary = 'auto';
  const bodyPayload: Record<string, unknown> = {
      model: input.model ?? config.openai.model,
      instructions: input.instructions,
      input: input.items,
      previous_response_id: input.previousResponseId ?? undefined,
      prompt_cache_key: input.promptCacheKey ?? undefined,
      tools: input.tools,
      tool_choice: 'auto',
      parallel_tool_calls: input.parallelToolCalls ?? false,
      text: textVerbosity ? { verbosity: textVerbosity } : undefined,
      reasoning: reasoningPayload,
      safety_identifier: input.safetyIdentifier || undefined,
      store: config.openai.storeResponses,
      stream: config.openai.responsesTransport === 'http_sse' ? true : undefined,
      include: input.preserveReasoning && config.openai.supportsEncryptedReasoningReplay
        ? ['reasoning.encrypted_content']
        : [],
    };
  // Only send optional parameters when explicitly configured.
  if (maxTokens > 0) bodyPayload.max_output_tokens = maxTokens;
  if (input.truncation && config.openai.supportsTruncation) {
    bodyPayload.truncation = input.truncation;
  }
  if (input.contextManagement) {
    bodyPayload.context_management = input.contextManagement;
  }
  const bodyJson = JSON.stringify(bodyPayload);
  console.log('[api] POST %s/responses — payload %d chars, %d tools, %d input items, prevId=%s',
    baseUrl, bodyJson.length, input.tools.length, input.items.length,
    input.previousResponseId ?? 'none');
  const admissionStartedAt = Date.now();
  const releaseResponseSlot = await getResponseAdmission().acquire(input.signal);
  const requestStartedAt = Date.now();
  let events: NativeSseEvent[];
  // A fresh model call restarts the answer text: drop whatever partial text a
  // consumer accumulated from a previous iteration or a retried attempt.
  if (streamThisCall) reportActivity({ type: 'text_delta', text: '', reset: true });
  try {
    events = await requestHttpSseEvents(baseUrl, bodyJson, timeoutMs, streamThisCall, input.signal);
  } finally {
    releaseResponseSlot();
  }
  const completedPayload = findCompletedPayload(events);
  console.log(
    '[api] DONE transport=%s queue_ms=%d request_ms=%d total_ms=%d events=%d status=%s',
    config.openai.responsesTransport,
    requestStartedAt - admissionStartedAt,
    Date.now() - requestStartedAt,
    Date.now() - admissionStartedAt,
    events.length,
    completedPayload?.status ?? 'unknown',
  );
  const doneItems = collectDoneItems(events);
  const completedOutput = Array.isArray(completedPayload?.output)
    ? completedPayload.output
    : null;
  let output = completedOutput && completedOutput.length > 0
    ? completedOutput
    : doneItems;
  const outputTextFromItems = extractOutputText(output);
  const outputTextFromStream = extractStreamedOutputText(events);
  const outputText = completedPayload?.output_text
    ?? (outputTextFromStream || outputTextFromItems);
  // Any stream without a terminal event is truncated. Partial output is not
  // safe to dispatch: it may contain a function call whose response was never
  // committed by the provider.
  const sawTerminalEvent = events.some(
    (event) => event.event === 'response.completed'
      || event.event === 'response.done'
      || event.event === 'response.incomplete'
      || event.event === 'response.failed',
  );
  const incompleteStream = !sawTerminalEvent;
  const errorMessage = sanitizeProviderErrorMessage(completedPayload?.error?.message)
    ?? findStreamError(events)
    ?? (incompleteStream ? 'Incomplete response stream (no terminal event received)' : null);

  const toolSearchPaths = extractToolSearchPaths(output);

  // Debug: log usage, reasoning summary, and tool_search activity
  const usage = (completedPayload as Record<string, unknown> | null)?.usage as Record<string, unknown> | undefined;
  if (usage) {
    console.log('[usage] input=%s output=%s total=%s cached=%s cache_write=%s reasoning=%s',
      usage.input_tokens ?? '?', usage.output_tokens ?? '?', usage.total_tokens ?? '?',
      (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? '0',
      (usage.input_tokens_details as Record<string, unknown> | undefined)?.cache_write_tokens ?? '0',
      (usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens ?? '0');
  }

  // Log reasoning summary if present (enabled by reasoning.summary='auto').
  // When streaming (activityWantsTokens), the reasoning line was already emitted
  // live from the stream, before the answer — don't emit it again post-parse.
  const reasoningSummary = extractReasoningSummary(output);
  if (reasoningSummary) {
    console.log('[reasoning] %s', reasoningSummary.slice(0, 500));
    // Surface reasoning only for the top-level agent turn with a sink attached
    // (the CLI). Internal calls (streamThisCall false) and the bots (no sink)
    // never emit it.
    if (streamThisCall) reportActivity({ type: 'reasoning', text: reasoningSummary });
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
      cacheWrite: Number((usage.input_tokens_details as Record<string, unknown> | undefined)?.cache_write_tokens ?? 0),
      reasoning: Number((usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens ?? 0),
    } : null,
    status: completedPayload?.status ?? inferTerminalStatus(events),
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
  results: Array<{ callId: string; output: string; caller?: NativeFunctionCaller }>,
): NativeFunctionCallOutputItem[] {
  return results.map((entry) => ({
    type: 'function_call_output',
    call_id: entry.callId,
    output: entry.output,
    ...(entry.caller ? { caller: entry.caller } : {}),
  }));
}

export function buildFunctionCallInputItems(
  output: NativeResponseOutputItem[],
): NativeFunctionCallItem[] {
  return output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      ...item,
      type: 'function_call' as const,
      call_id: String(item.call_id ?? item.id ?? ''),
      name: String(item.name ?? ''),
      arguments: String(item.arguments ?? '{}'),
    }))
    .filter((item) => item.call_id && item.name);
}

/**
 * Replay one stateless response round in exact provider output order. Every
 * provider-owned field stays in memory for this turn and is never reconstructed.
 */
export function buildOrderedContinuationInputItems(
  output: NativeResponseOutputItem[],
  includeReasoning = true,
): NativeResponseOutputItem[] {
  return output
    .filter((item) => includeReasoning || item.type !== 'reasoning')
    .map((item) => ({ ...item }));
}

export function extractFunctionCalls(
  output: NativeResponseOutputItem[],
): Array<{ callId: string; name: string; argumentsText: string; caller?: unknown }> {
  return output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      callId: String(item.call_id ?? item.id ?? ''),
      name: String(item.name ?? ''),
      argumentsText: String(item.arguments ?? '{}'),
      ...(item.caller !== undefined ? { caller: item.caller } : {}),
    }))
    .filter((item) => item.callId && item.name);
}

export function extractClientToolSearchCalls(
  output: NativeResponseOutputItem[],
): Array<{ callId: string; arguments: unknown }> {
  return output
    .filter((item) => item.type === 'tool_search_call' && item.execution === 'client')
    .map((item) => ({
      callId: typeof item.call_id === 'string' && item.call_id === item.call_id.trim()
        ? item.call_id
        : '',
      arguments: item.arguments,
    }))
    .filter((item) => item.callId.length > 0);
}

export function extractFinalAssistantText(output: NativeResponseOutputItem[]): string | null {
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const item = output[index]!;
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) continue;
    const chunks: string[] = [];
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
      if (part.type === 'refusal' && typeof part.refusal === 'string') chunks.push(part.refusal);
    }
    return chunks.join('\n').trim();
  }
  return null;
}

async function requestHttpSseEvents(
  baseUrl: string,
  bodyJson: string,
  timeoutMs: number,
  streamToActivity: boolean,
  signal?: AbortSignal,
): Promise<NativeSseEvent[]> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events: NativeSseEvent[] = [];
  const parser = createSseParser((event) => {
    events.push(event);
    maybeEmitTextDelta(event, streamToActivity);
  });
  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.openai.apiKey}`,
      },
      body: bodyJson,
    });
    if (!response.ok) {
      // Error bodies are small and read whole: the message feeds classification.
      const rawText = await response.text();
      const category = classifyHttpError(rawText);
      throw new Error(`Responses API HTTP ${response.status}${category ? ` (${category})` : ''}`);
    }
    if (!response.body) {
      parser.feed(await response.text());
    } else {
      // Read the stream as it arrives so output-text deltas reach the activity
      // sink while the model is still generating, not after the full body.
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.feed(decoder.decode());
    }
    parser.end();
  } catch (error) {
    if ((error as Error).name === 'AbortError' || (error as Error).name === 'TimeoutError') {
      if (signal?.aborted) throw new Error('Responses request aborted');
      throw new Error(`Responses API timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
  return events;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  if (!trimmed) return 'https://api.openai.com/v1';
  return trimmed;
}

/**
 * Incremental SSE parser: feed() accepts arbitrary text chunks (events may be
 * split across reads), end() flushes the trailing partial line and event.
 * parseSse() below is the whole-buffer wrapper kept for tests and fallbacks.
 */
function createSseParser(onEvent: (event: NativeSseEvent) => void): {
  feed: (text: string) => void;
  end: () => void;
} {
  let buffer = '';
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
    onEvent({ event, data });
    currentEvent = 'message';
  };

  const processLine = (line: string) => {
    if (line === '') {
      flush();
      return;
    }
    if (line.startsWith(':')) {
      return;
    }
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim() || 'message';
      return;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^\s/, ''));
      return;
    }
    if (line.startsWith('id:') || line.startsWith('retry:')) {
      return;
    }
    dataLines.push(line);
  };

  return {
    feed(text: string) {
      buffer += text;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buffer = buffer.slice(newline + 1);
        processLine(line);
        newline = buffer.indexOf('\n');
      }
    },
    end() {
      if (buffer) {
        let line = buffer;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buffer = '';
        processLine(line);
      }
      flush();
    },
  };
}

function parseSse(raw: string): NativeSseEvent[] {
  const events: NativeSseEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  parser.feed(raw);
  parser.end();
  return events;
}

function isOutputTextDelta(event: string): boolean {
  return event === 'response.output_text.delta' || event === 'response.text.delta';
}

/** Pull the token string out of a text-delta payload, tolerating provider shape drift. */
function textDeltaToken(data: unknown): string | null {
  const record = data as Record<string, unknown> | null;
  const delta = typeof record?.delta === 'string' ? record.delta : null;
  const text = typeof record?.text === 'string' ? record.text : null;
  const outputText = typeof record?.output_text === 'string' ? record.output_text : null;
  const nestedText = typeof (record?.output_text as { text?: unknown } | undefined)?.text === 'string'
    ? (record?.output_text as { text?: string }).text
    : null;
  const token = delta ?? text ?? outputText ?? nestedText;
  return token ? token : null;
}

/** Live-emit one parsed stream event's text token to the activity sink, if streaming is on. */
function maybeEmitTextDelta(event: NativeSseEvent, streamToActivity: boolean): void {
  if (!streamToActivity || !isOutputTextDelta(event.event)) return;
  const token = textDeltaToken(event.data);
  if (token) reportActivity({ type: 'text_delta', text: token });
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
      const token = textDeltaToken(event.data);
      if (token) {
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
  type CollectedItem = {
    item: NativeResponseOutputItem;
    outputIndex: number | null;
    sequence: number;
  };
  const addedFunctionCalls = new Map<string, CollectedItem>();
  const output = new Map<string, CollectedItem>();

  for (let sequence = 0; sequence < events.length; sequence += 1) {
    const event = events[sequence]!;
    if (event.event !== 'response.output_item.added' && event.event !== 'response.output_item.done') {
      continue;
    }
    const data = event.data as {
      item?: NativeResponseOutputItem;
      output_item?: NativeResponseOutputItem;
      output_index?: unknown;
    } | null;
    const item = data?.item ?? data?.output_item ?? null;
    if (item?.type !== 'function_call' || typeof item.id !== 'string' || !item.id) continue;
    addedFunctionCalls.set(item.id, {
      item,
      outputIndex: validOutputIndex(data?.output_index),
      sequence,
    });
  }

  for (let sequence = 0; sequence < events.length; sequence += 1) {
    const event = events[sequence]!;
    if (
      event.event !== 'response.output_item.done'
      && event.event !== 'response.function_call_arguments.done'
    ) {
      continue;
    }
    const data = event.data as {
      item?: NativeResponseOutputItem;
      output_item?: NativeResponseOutputItem;
      output_index?: unknown;
      item_id?: unknown;
      call_id?: unknown;
      name?: unknown;
      arguments?: unknown;
    } | null;
    let item = data?.item ?? data?.output_item ?? null;
    let added: CollectedItem | undefined;
    if (!item && event.event === 'response.function_call_arguments.done') {
      const itemId = typeof data?.item_id === 'string' ? data.item_id : '';
      added = addedFunctionCalls.get(itemId);
      const callId = typeof data?.call_id === 'string'
        ? data.call_id
        : typeof added?.item.call_id === 'string'
          ? added.item.call_id
          : '';
      const name = typeof data?.name === 'string'
        ? data.name
        : typeof added?.item.name === 'string'
          ? added.item.name
          : '';
      if (itemId && callId && name && typeof data?.arguments === 'string') {
        item = {
          ...(added?.item ?? {}),
          type: 'function_call',
          id: itemId,
          call_id: callId,
          name,
          arguments: data.arguments,
        };
      }
    }
    if (item && typeof item === 'object' && typeof item.type === 'string') {
      const identity = item.call_id ?? item.id;
      // Only function_call has a legitimate multi-event lifecycle that must be
      // merged. Preserve other done records in provider order.
      const key = item.type === 'function_call' && identity != null
        ? `${item.type}:${String(identity)}`
        : `${item.type}:${identity == null ? 'anonymous' : String(identity)}:sequence:${sequence}`;
      const existing = output.get(key);
      const mergedItem = existing ? { ...existing.item, ...item } : item;
      if (
        item.type === 'function_call'
        && typeof existing?.item.arguments === 'string'
        && typeof item.arguments === 'string'
        && existing.item.arguments.length > item.arguments.length
      ) {
        mergedItem.arguments = existing.item.arguments;
      }
      output.set(key, {
        item: mergedItem,
        outputIndex: validOutputIndex(data?.output_index)
          ?? added?.outputIndex
          ?? existing?.outputIndex
          ?? null,
        sequence: existing?.sequence ?? sequence,
      });
    }
  }
  const collected = [...output.values()];
  const hasCompleteCanonicalOrder = collected.every((entry) => entry.outputIndex !== null);
  collected.sort((left, right) => hasCompleteCanonicalOrder
    ? left.outputIndex! - right.outputIndex! || left.sequence - right.sequence
    : left.sequence - right.sequence);
  return collected.map((entry) => entry.item);
}

function validOutputIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function findCompletedPayload(events: NativeSseEvent[]): NativeResponseEnvelope | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.event !== 'response.completed'
      && event.event !== 'response.done'
      && event.event !== 'response.incomplete'
      && event.event !== 'response.failed'
    ) continue;
    const data = event.data as { response?: NativeResponseEnvelope } | NativeResponseEnvelope | null;
    if (!data || typeof data !== 'object') continue;
    if ('response' in data && data.response && typeof data.response === 'object') {
      return data.response;
    }
    return data as NativeResponseEnvelope;
  }
  return null;
}

function inferTerminalStatus(events: NativeSseEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.event;
    if (type === 'response.completed' || type === 'response.done') return 'completed';
    if (type === 'response.incomplete') return 'incomplete';
    if (type === 'response.failed') return 'failed';
  }
  return null;
}

function findStreamError(events: NativeSseEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event === 'error' || event.event === 'response.error' || event.event === 'response.failed') {
      const data = event.data as Record<string, unknown> | null;
      // Provider error payloads can contain hosted-tool details. Keep logs to
      // event metadata; the caller receives the message only for control flow.
      console.log('[api] stream error event=%s', event.event);
      const message = (data?.error as Record<string, unknown> | undefined)?.message
        ?? (data as Record<string, unknown> | undefined)?.message
        ?? (data?.error as Record<string, unknown> | undefined)?.code;
      if (typeof message === 'string' && message) return sanitizeProviderErrorMessage(message);
      return `Responses API error (${event.event})`;
    }
  }
  return null;
}

function sanitizeProviderErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const lower = value.toLowerCase();
  if (lower.includes('no tool call found for function call output with call_id')) {
    return 'tool_state_mismatch';
  }
  if (
    (lower.includes('previous_response_id') || lower.includes('previous response'))
    && (lower.includes('not found') || lower.includes('expired'))
  ) {
    return 'response_state_missing';
  }
  if (lower.includes('rate') && lower.includes('limit')) return 'Responses API error (rate_limit)';
  if (lower.includes('overload')) return 'Responses API error (overloaded)';
  if (lower.includes('server') || lower.includes('temporar')) return 'Responses API error (server_error)';
  return 'Responses API provider error';
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
  maybeEmitTextDelta,
};

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

function extractReasoningSummary(items: NativeResponseOutputItem[]): string | null {
  for (const item of items) {
    if (item.type === 'reasoning' || item.type === 'reasoning_summary') {
      const summary = Array.isArray(item.summary)
        ? (item.summary as Array<{ text?: string }>).map((s) => s.text ?? '').join('')
        : typeof item.summary === 'string' ? item.summary : null;
      if (summary) return summary;
      if (typeof item.text === 'string' && item.text) return item.text;
    }
  }
  return null;
}

function classifyHttpError(raw: string): 'tool_state_mismatch' | 'response_state_missing' | null {
  const lower = raw.toLowerCase();
  if (lower.includes('no tool call found for function call output with call_id')) {
    return 'tool_state_mismatch';
  }
  const referencesResponseState = lower.includes('previous_response_id')
    || lower.includes('previous response');
  if (referencesResponseState && (lower.includes('not found') || lower.includes('expired'))) {
    return 'response_state_missing';
  }
  return null;
}
