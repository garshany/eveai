import type { Db } from '../db/sqlite.js';
import { buildDeveloperPrompt } from './prompts.js';
import {
  buildNativeAgentTools,
  executeSdeSql,
  planRoute,
  getToolPolicy,
  isSdeSqlTool,
  isZkillToolName,
} from './tools.js';
import type { PlanRouteArgs } from './tools.js';
import {
  buildFunctionCallOutputs,
  createNativeResponse,
  extractFunctionCalls,
  toNativeMessage,
  type NativeInputItem,
} from './native-responses.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { readUserProfile } from '../eve/user-profile.js';
import { webSearch, type WebSearchRequest } from './web-search.js';
import { createRequestId } from './planner.js';
import { getThreadSummary } from './compact.js';
import { executeZkillQuery } from '../eve/zkill-query.js';
import { getLinkedCharacter } from '../eve/sso.js';

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 3500;
const MAX_TOOL_ITERATIONS = 32;

export async function handleAgentMessage(
  db: Db,
  threadId: string,
  chatId: number,
  userText: string,
): Promise<string> {
  ensureThreadExists(db, threadId, chatId);
  const summary = getThreadSummary(db, threadId);
  const userProfile = readUserProfile(db, chatId);
  const linked = getLinkedCharacter(db, chatId);

  // Fetch live location + ship at request time so it's in the prompt
  const liveContext = linked ? await fetchLiveContext(db, linked.characterId, chatId) : null;

  const developerPrompt = buildDeveloperPrompt(
    {
      authenticated: Boolean(linked),
      characterId: linked?.characterId ?? null,
      characterName: linked?.characterName ?? null,
      grantedScopes: linked?.scopes ?? [],
    },
    summary,
    userProfile,
    liveContext,
  );

  return await runNativeAgentLoop(db, threadId, chatId, userText, developerPrompt);
}

async function fetchLiveContext(db: Db, characterId: number, chatId: number): Promise<string | null> {
  try {
    const [locationResult, shipResult] = await Promise.all([
      callEsiOperation<{ solar_system_id: number; station_id?: number; structure_id?: number }>(
        db, 'get_characters_character_id_location', { character_id: characterId }, chatId,
      ),
      callEsiOperation<{ ship_type_id: number; ship_item_id: number; ship_name: string }>(
        db, 'get_characters_character_id_ship', { character_id: characterId }, chatId,
      ),
    ]);

    const parts: string[] = [];

    if (locationResult.ok) {
      const sysId = locationResult.data.solar_system_id;
      const sysRow = db.prepare(
        "SELECT name, json_extract(data_json, '$.security') as sec FROM sde_systems WHERE system_id = ?"
      ).get(sysId) as { name: string; sec: number } | undefined;
      const sysName = sysRow?.name ?? `ID ${sysId}`;
      const sec = sysRow?.sec != null ? ` (sec ${Number(sysRow.sec).toFixed(1)})` : '';
      parts.push(`Система: ${sysName}${sec}, system_id=${sysId}`);
      if (locationResult.data.station_id) parts.push(`Станция: station_id=${locationResult.data.station_id}`);
    }

    if (shipResult.ok) {
      const typeRow = db.prepare('SELECT name FROM sde_types WHERE type_id = ?').get(shipResult.data.ship_type_id) as { name: string } | undefined;
      const shipType = typeRow?.name ?? `type_id ${shipResult.data.ship_type_id}`;
      parts.push(`Корабль: ${shipResult.data.ship_name} (${shipType}), type_id=${shipResult.data.ship_type_id}`);
    }

    return parts.length > 0 ? parts.join('\n') : null;
  } catch {
    return null;
  }
}

async function runNativeAgentLoop(
  db: Db,
  threadId: string,
  chatId: number,
  goal: string,
  developerPrompt: string,
): Promise<string> {
  const historyRows = db.prepare(
    "SELECT content FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at ASC"
  ).all(threadId) as Array<{ content: string }>;
  const requestId = createRequestId();
  const tools = await buildNativeAgentTools();

  let pendingItems: NativeInputItem[] = selectRecentHistory(historyRows)
    .map((row) => toNativeMessage(row.content));
  let previousResponseId: string | null = null;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const response = await createNativeResponse({
      instructions: developerPrompt,
      items: pendingItems,
      previousResponseId,
      tools,
      parallelToolCalls: true,
    });

    if (response.error) {
      const message = response.error.message;
      storeAssistantMessage(db, threadId, message);
      return message;
    }

    if (response.toolSearchPaths.length > 0) {
      console.log('[executor] iteration=%d toolSearchPaths=%j', iteration, response.toolSearchPaths);
    }

    const toolCalls = extractFunctionCalls(response.output);
    if (toolCalls.length === 0) {
      if (response.outputText.trim()) {
        storeAssistantMessage(db, threadId, response.outputText);
        return response.outputText;
      }
      if (response.toolSearchPaths.length > 0 && response.id) {
        previousResponseId = response.id;
        pendingItems = [];
        continue;
      }
      const fallback = 'Не удалось завершить ответ: модель не вернула ни текст, ни tool calls.';
      storeAssistantMessage(db, threadId, fallback);
      return fallback;
    }

    const policies = await Promise.all(toolCalls.map((toolCall) => getToolPolicy(toolCall.name)));
    const argsList = toolCalls.map((toolCall) => safeParseArguments(toolCall.argumentsText));
    const results = policies.every((policy) => policy === 'read')
      ? await Promise.all(toolCalls.map((toolCall, index) =>
          executeToolCall(db, requestId, goal, chatId, toolCall.name, argsList[index] ?? {}),
        ))
      : await executeToolCallsSequentially(db, requestId, goal, chatId, toolCalls, argsList);

    const outputs: Array<{ callId: string; output: string }> = [];
    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index];
      const args = argsList[index] ?? {};
      const result = results[index];
      db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(
        threadId,
        'tool',
        JSON.stringify({
          tool: toolCall.name,
          args,
          result: compactToolResult(result),
        }),
      );
      outputs.push({
        callId: toolCall.callId,
        output: truncateToolOutput(JSON.stringify(result)),
      });
    }

    if (!response.id) {
      const message = 'Не удалось продолжить tool loop: proxy не вернул response id.';
      storeAssistantMessage(db, threadId, message);
      return message;
    }

    previousResponseId = response.id;
    pendingItems = buildFunctionCallOutputs(outputs);
  }

  const timeout = 'Остановился после слишком большого числа tool iterations.';
  storeAssistantMessage(db, threadId, timeout);
  return timeout;
}

async function executeToolCallsSequentially(
  db: Db,
  requestId: string,
  goal: string,
  chatId: number,
  toolCalls: Array<{ callId: string; name: string; argumentsText: string }>,
  argsList: Array<Record<string, unknown>>,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    results.push(await executeToolCall(db, requestId, goal, chatId, toolCalls[index].name, argsList[index] ?? {}));
  }
  return results;
}

async function executeToolCall(
  db: Db,
  requestId: string,
  goal: string,
  chatId: number,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === 'web_search') {
    const req: WebSearchRequest = {
      query: String(args.query ?? ''),
      source: normalizeWebSource(args.source),
      limit: normalizeLimit(args.limit, 5, 1, 10),
    };
    return await webSearch(req);
  }

  if (isSdeSqlTool(name)) {
    return executeSdeSql(db, String(args.sql ?? ''));
  }

  if (name === 'plan_route') {
    const routeArgs: PlanRouteArgs = {
      origin: String(args.origin ?? ''),
      destination: String(args.destination ?? ''),
      set_autopilot: args.set_autopilot !== false,
      avoid: Array.isArray(args.avoid) ? args.avoid.filter((v): v is number => typeof v === 'number') : [],
      prefer: args.prefer === 'shortest' || args.prefer === 'insecure' ? args.prefer : 'secure',
    };
    const routeResult = await planRoute(db, routeArgs, chatId);
    const totalRecentKills = routeResult.routes.reduce((s, r) =>
      s + r.hotspots.reduce((hs, h) => hs + (h.recent_kills?.length ?? 0), 0), 0);
    console.log('[plan_route] origin=%s dest=%s routes=%d autopilot=%s recent_kills=%d error=%s',
      routeResult.origin?.name ?? '?', routeResult.destination?.name ?? '?',
      routeResult.routes.length, routeResult.autopilot_set, totalRecentKills, routeResult.error ?? 'none');
    for (const r of routeResult.routes) {
      console.log('[plan_route]   %s: %d jumps, danger=%d, hotspots=%d, ship_kills=%d, pod_kills=%d',
        r.flag, r.jumps, r.danger_score, r.hotspots.length, r.total_ship_kills, r.total_pod_kills);
    }
    return routeResult;
  }

  if (isZkillToolName(name)) {
    const path = String(args.path ?? '');
    const detailLimit = typeof args.detail_limit === 'number' ? args.detail_limit : 3;
    return await executeZkillQuery(db, path, detailLimit, chatId);
  }

  return await callEsiOperation(db, name, args, chatId);
}

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function normalizeWebSource(value: unknown): WebSearchRequest['source'] {
  return value === 'eve_uni' || value === 'esi_docs' || value === 'general' || value === 'openai'
    ? value
    : 'all';
}

function normalizeLimit(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function selectRecentHistory(rows: Array<{ content: string }>): Array<{ content: string }> {
  const recent = rows.slice(-MAX_HISTORY_MESSAGES);
  const selected: Array<{ content: string }> = [];
  let totalChars = 0;

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const row = recent[index];
    if (selected.length > 0 && totalChars + row.content.length > MAX_HISTORY_CHARS) {
      break;
    }
    selected.push(row);
    totalChars += row.content.length;
  }

  return selected.reverse();
}

function compactToolResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      count: value.length,
      sample: value.slice(0, 3).map((item) => compactToolResult(item)),
    };
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record).slice(0, 12)) {
    if (Array.isArray(entry)) {
      compacted[key] = {
        count: entry.length,
        sample: entry.slice(0, 3).map((item) => compactToolResult(item)),
      };
      continue;
    }
    if (entry && typeof entry === 'object') {
      compacted[key] = compactToolResult(entry);
      continue;
    }
    compacted[key] = entry;
  }
  return compacted;
}

const MAX_TOOL_OUTPUT_CHARS = 12000;

function truncateToolOutput(json: string): string {
  if (json.length <= MAX_TOOL_OUTPUT_CHARS) return json;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      const truncated = parsed.slice(0, 50);
      const result = JSON.stringify({ items: truncated, truncated: true, total: parsed.length });
      if (result.length <= MAX_TOOL_OUTPUT_CHARS) return result;
      const smaller = parsed.slice(0, 20);
      return JSON.stringify({ items: smaller, truncated: true, total: parsed.length });
    }
  } catch {
    // fall through
  }
  return json.slice(0, MAX_TOOL_OUTPUT_CHARS) + '...(truncated)';
}

function storeAssistantMessage(db: Db, threadId: string, content: string): void {
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'assistant', content);
}

function ensureThreadExists(db: Db, threadId: string, chatId: number): void {
  db.prepare(
    `INSERT INTO telegram_sessions (chat_id, last_seen_at)
     VALUES (?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET last_seen_at = datetime('now')`
  ).run(chatId);
  db.prepare(
    `INSERT OR IGNORE INTO agent_threads (thread_id, chat_id)
     VALUES (?, ?)`
  ).run(threadId, chatId);
}
