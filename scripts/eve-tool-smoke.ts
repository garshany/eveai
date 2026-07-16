import 'dotenv/config';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { handleAgentMessage } from '../src/agent/executor.js';
import { __test__ } from '../src/agent/executor.js';
import { buildNativeAgentTools } from '../src/agent/tools.js';
import {
  createNativeResponse,
  extractFunctionCalls,
  toNativeMessage,
  type NativeFunctionTool,
  type NativeTool,
} from '../src/agent/native-responses.js';
import { runWithActivitySink, type AgentActivityEvent } from '../src/agent/activity.js';
import {
  isProgrammaticToolName,
  validateProgrammaticToolOutput,
} from '../src/agent/programmatic-contracts.js';

const mode = (process.env.EVE_TOOL_SMOKE_MODE || process.argv[2] || 'agent').replace(/^--/, '');
const sourceDb = resolve(process.env.DB_PATH || './data/eve-agent.db');

if (!existsSync(sourceDb)) {
  fail(`DB not found at ${sourceDb}. Run npm run setup first or set DB_PATH.`);
}

const tempDb = join(tmpdir(), `eveai-tool-smoke-${Date.now()}.db`);
copyFileSync(sourceDb, tempDb);
const db = new Database(tempDb);
db.pragma('foreign_keys = ON');
runMigrations(db);

try {
  if (mode === 'direct') {
    await runDirectToolSmoke(db);
  } else if (mode === 'agent') {
    await runAgentToolSmoke(db);
  } else if (mode === 'public-source-matrix') {
    await runPublicSourceMatrix(db);
  } else if (mode === 'programmatic-matrix') {
    await runProgrammaticMatrix(db);
  } else if (mode === 'schema-wire-matrix') {
    await runSchemaWireMatrix();
  } else {
    fail(`Unknown EVE_TOOL_SMOKE_MODE: ${mode}. Use agent, direct, public-source-matrix, schema-wire-matrix, or programmatic-matrix.`);
  }
} finally {
  db.close();
}

async function runSchemaWireMatrix(): Promise<void> {
  if (process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING?.trim().toLowerCase() !== 'true') {
    fail('schema-wire-matrix requires OPENAI_PROGRAMMATIC_TOOL_CALLING=true');
  }
  const allTools = await buildNativeAgentTools('full');
  const functions = allTools.flatMap((tool): NativeFunctionTool[] => {
    if (tool.type === 'function') return [tool];
    if (tool.type === 'namespace') return tool.tools;
    return [];
  });
  let allPassed = true;
  const selectedScenario = process.env.EVE_TOOL_SMOKE_SCENARIO?.trim();
  for (const name of [
    'count_universe_objects',
    'batch_market_prices',
    'compare_wormhole_types',
    'scout_systems',
    'kill_activity_summary',
    'market_history_summary',
    'system_metric_snapshot',
    'doctrine_summary',
    'dynamic_item_summary',
  ]) {
    if (selectedScenario && selectedScenario !== name && selectedScenario !== `wire-schema-${name}`) continue;
    const tool = functions.find((candidate) => candidate.name === name);
    const started = Date.now();
    let passed = false;
    if (tool) {
      const namespace = allTools.find((candidate) =>
        candidate.type === 'namespace' && candidate.tools.some((nested) => nested.name === name));
      const probeTools: NativeTool[] = namespace?.type === 'namespace'
        ? [{ type: 'tool_search' }, { ...namespace, tools: [tool] }]
        : [tool];
      passed = await acceptsWireTools(probeTools);
    }
    allPassed &&= passed;
    console.log(JSON.stringify({
      scenario_id: `wire-schema-${name}`,
      passed,
      source_category: 'OpenAI schema wire',
      elapsed_milliseconds: Date.now() - started,
      eligible_tool_names: [name],
      schema_validation: passed,
    }));
  }
  if (!allPassed) process.exitCode = 1;
}

async function acceptsWireTools(tools: NativeTool[]): Promise<boolean> {
  try {
    await withMutedRuntimeLogs(() => createNativeResponse({
      instructions: 'Return a short final answer without calling tools.',
      items: [toNativeMessage('Reply OK.')],
      tools: [{ type: 'programmatic_tool_calling' }, ...tools],
      parallelToolCalls: true,
      truncation: 'auto',
    }));
    return true;
  } catch {
    return false;
  }
}

async function runPublicSourceMatrix(db: Database.Database): Promise<void> {
  const now = new Date();
  const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const doctrineFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const dynamicSamples = readDynamicSmokeSamples();
  const scenarios: Array<{
    id: string;
    tool: string;
    args: Record<string, unknown>;
    source: string;
    workUnits: number;
  }> = [
    {
      id: 'public-market',
      tool: 'batch_market_prices',
      args: { region_id: 10000002, type_ids: [34, 44992] },
      source: 'CCP ESI',
      workUnits: 2,
    },
    {
      id: 'public-wormhole-types',
      tool: 'compare_wormhole_types',
      args: { identifiers: ['C140', 'A239'] },
      source: 'EVE-Scout',
      workUnits: 2,
    },
    {
      id: 'public-systems',
      tool: 'scout_systems',
      args: { query: 'Jita', space: null, limit: 5 },
      source: 'EVE-Scout',
      workUnits: 5,
    },
    {
      id: 'public-kill-summary',
      tool: 'kill_activity_summary',
      args: { scope: 'system', id: 30000142, activity: 'all', from, to: now.toISOString(), evidence_limit: 5 },
      source: 'EVE-KILL',
      workUnits: 5,
    },
    {
      id: 'public-market-history-summary',
      tool: 'market_history_summary',
      args: { region_id: 10000002, type_id: 34, days: 30 },
      source: 'CCP ESI',
      workUnits: 30,
    },
    {
      id: 'public-system-metric-snapshot',
      tool: 'system_metric_snapshot',
      args: { metric: 'kills', system_ids: [30000142, 30002187] },
      source: 'CCP ESI',
      workUnits: 2,
    },
    {
      id: 'public-doctrine-summary',
      tool: 'doctrine_summary',
      args: {
        entity_id: 1354830081,
        entity_type: 'alliance',
        from: doctrineFrom,
        to: now.toISOString(),
        top: 2,
      },
      source: 'EVE-KILL MCP',
      workUnits: 2,
    },
    ...(dynamicSamples.length > 0 ? [{
      id: 'public-dynamic-item-summary',
      tool: 'dynamic_item_summary',
      args: {
        type_id: dynamicSamples[0]!.typeId,
        item_id: dynamicSamples[0]!.itemId,
        attribute_ids: dynamicSamples[0]!.attributeIds,
      },
      source: 'CCP ESI plus local SDE',
      workUnits: dynamicSamples[0]!.attributeIds.length,
    }] : []),
  ];

  let allPassed = true;
  const selectedScenario = process.env.EVE_TOOL_SMOKE_SCENARIO?.trim();
  for (const scenario of scenarios) {
    if (selectedScenario && selectedScenario !== scenario.id) continue;
    const started = Date.now();
    let result: unknown;
    try {
      result = await withMutedRuntimeLogs(() => __test__.executeToolCall(
        db,
        'public-source-smoke',
        'bounded public source verification',
        { userId: 0, chatId: 0 },
        scenario.tool,
        scenario.args,
        { normalizedQueries: [], eveKillCallCount: 0, eveKillAnalyticsCallCount: 0 },
      ));
    } catch {
      result = null;
    }
    const serialized = safeJson(result);
    const record = result && typeof result === 'object' && !Array.isArray(result)
      ? result as Record<string, unknown>
      : null;
    const schema = isProgrammaticToolName(scenario.tool)
      ? validateProgrammaticToolOutput(scenario.tool, result)
      : { valid: false };
    const passed = record?.ok === true && schema.valid && serialized.length <= 12_000;
    allPassed &&= passed;
    console.log(JSON.stringify({
      scenario_id: scenario.id,
      passed,
      source_category: scenario.source,
      elapsed_milliseconds: Date.now() - started,
      eligible_tool_names: [scenario.tool],
      work_units: scenario.workUnits,
      local_output_character_counts: [serialized.length],
      schema_validation: schema.valid,
    }));
  }
  if (dynamicSamples.length < 1
    && (!selectedScenario || selectedScenario === 'public-dynamic-item-summary')) {
    allPassed = false;
    console.log(JSON.stringify({
      scenario_id: 'public-dynamic-item-summary',
      passed: false,
      status: 'NOT_RUN',
      reason_category: 'public_sample_unavailable',
      source_category: 'CCP ESI plus local SDE',
      eligible_tool_names: ['dynamic_item_summary'],
      schema_validation: false,
    }));
  }
  if (!allPassed) process.exitCode = 1;
}

async function runProgrammaticMatrix(db: Database.Database): Promise<void> {
  if (process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING?.trim().toLowerCase() !== 'true') {
    fail('programmatic-matrix requires OPENAI_PROGRAMMATIC_TOOL_CALLING=true');
  }
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  const to = now.toISOString();
  const doctrineFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const doctrineTo = now.toISOString();
  const dynamicSamples = readDynamicSmokeSamples();
  const scenarios = [
    {
      id: 'hosted-count', tool: 'count_universe_objects', count: 2,
      prompt: 'Use Programmatic Tool Calling and only count_universe_objects. In one bounded program compare exactly two calls: systems in region The Forge and systems in region Domain. Run concurrently, reduce compactly, no retries, then give a short final answer.',
    },
    {
      id: 'hosted-market', tool: 'batch_market_prices', count: 2,
      prompt: 'Use Programmatic Tool Calling and only batch_market_prices. Compare the same ordered type_ids [34,35] across region_id 10000002 and 10000043 with two concurrent calls. Reduce compactly, no retries, then give a short final answer.',
    },
    {
      id: 'hosted-wormholes', tool: 'compare_wormhole_types', count: 1,
      prompt: 'Use Programmatic Tool Calling and only compare_wormhole_types. Make exactly one bounded facade call with identifiers ["C140","A239"]. Reduce the declared fields compactly, no retries, then give a short final answer.',
    },
    {
      id: 'hosted-systems', tool: 'scout_systems', count: 2,
      prompt: 'Use Programmatic Tool Calling and only scout_systems. Run two distinct concurrent bounded searches: query Jita space null limit 5, and query J100 space c3 limit 5. Reduce compactly, no retries, then give a short final answer.',
    },
    {
      id: 'hosted-kill-summary', tool: 'kill_activity_summary', count: 2,
      prompt: `Use Programmatic Tool Calling and only kill_activity_summary. Run two concurrent public system summaries for ids 30000142 and 30002187, activity all, from ${from}, to ${to}, evidence_limit 5. Reduce compactly, no retries, then give a short final answer.`,
    },
    {
      id: 'hosted-market-history-summary', tool: 'market_history_summary', count: 2,
      prompt: 'Use Programmatic Tool Calling and only market_history_summary. In one hosted program run exactly two concurrent calls with days 30: region/type pairs (10000002,34) and (10000043,34). Reduce only the declared bounded outputs, no retries, then give a short final answer.',
    },
    {
      id: 'hosted-system-metric-snapshot', tool: 'system_metric_snapshot', count: 2,
      prompt: 'Use Programmatic Tool Calling and only system_metric_snapshot. In one hosted program run exactly two concurrent calls over the same ordered system_ids [30000142,30002187], using distinct metrics kills and jumps. Join only the declared bounded rows, no retries, then give a short final answer.',
    },
    {
      id: 'hosted-doctrine-summary', tool: 'doctrine_summary', count: 2,
      prompt: `Use Programmatic Tool Calling and only doctrine_summary. In one hosted program run exactly two concurrent calls for alliance entity_ids 1354830081 and 99003214 with the identical window from ${doctrineFrom} to ${doctrineTo} and top 2. Compare only the declared bounded outputs, no retries, then give a short final answer.`,
    },
    ...(dynamicSamples.length >= 2 ? [{
      id: 'hosted-dynamic-item-summary', tool: 'dynamic_item_summary', count: 2,
      prompt: `Use Programmatic Tool Calling and only dynamic_item_summary. In one hosted program run exactly two concurrent calls for type/item pairs (${dynamicSamples[0]!.typeId},${dynamicSamples[0]!.itemId}) and (${dynamicSamples[1]!.typeId},${dynamicSamples[1]!.itemId}) with the identical ordered attribute_ids [${dynamicSamples[0]!.attributeIds.join(',')}]. Compare only the declared bounded outputs, no retries, then give a short final answer.`,
    }] : []),
  ];

  let allPassed = true;
  const selectedScenario = process.env.EVE_TOOL_SMOKE_SCENARIO?.trim();
  for (const scenario of scenarios) {
    if (selectedScenario && selectedScenario !== scenario.id) continue;
    const report = await runHostedScenario(db, scenario.id, scenario.prompt, scenario.tool, scenario.count, false);
    allPassed &&= report.passed === true;
    console.log(JSON.stringify(report));
  }
  if (dynamicSamples.length < 2
    && (!selectedScenario || selectedScenario === 'hosted-dynamic-item-summary')) {
    allPassed = false;
    console.log(JSON.stringify({
      scenario_id: 'hosted-dynamic-item-summary',
      passed: false,
      status: 'NOT_RUN',
      reason_category: 'public_sample_unavailable',
      source_category: 'OpenAI hosted program',
      eligible_tool_names: ['dynamic_item_summary'],
      accepted_programmatic_call_count: 0,
      rejected_programmatic_call_count: 0,
      schema_validation: false,
    }));
  }
  if (!selectedScenario || selectedScenario === 'hosted-negative-sde-sql') {
    const negative = await runHostedNegativeWireScenario(db);
    allPassed &&= negative.passed === true;
    console.log(JSON.stringify(negative));
  }
  for (const scenario of [
    {
      id: 'hosted-negative-mixed-family',
      prompt: 'Use one hosted program with exactly two concurrent calls: market_history_summary for region_id 10000002 type_id 34 days 30, and system_metric_snapshot for metric kills system_ids [30000142]. The application should reject the mixed family. Do not retry; return a short final answer after the rejection.',
    },
    {
      id: 'hosted-negative-over-budget',
      prompt: 'Use one hosted program with exactly five concurrent market_history_summary calls, all days 30, for distinct region/type pairs (10000002,34), (10000043,34), (10000032,34), (10000042,34), and (10000030,34). The application should reject the over-budget program. Do not retry; return a short final answer after the rejection.',
    },
  ]) {
    if (selectedScenario && selectedScenario !== scenario.id) continue;
    const negative = await runHostedScenario(db, scenario.id, scenario.prompt, '', 0, true);
    allPassed &&= negative.passed === true;
    console.log(JSON.stringify(negative));
  }
  if (!allPassed) process.exitCode = 1;
}

async function runHostedNegativeWireScenario(db: Database.Database): Promise<Record<string, unknown>> {
  const started = Date.now();
  const syntheticDisallowedTool: NativeFunctionTool = {
    type: 'function',
    name: 'sde_sql',
    description: 'Synthetic wire-only exposure used to prove the application allowlist rejects a provider-returned programmatic call.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
      additionalProperties: false,
    },
    allowed_callers: ['direct', 'programmatic'],
    output_schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        blocked: { type: 'boolean' },
        error: { type: 'string' },
      },
      required: ['ok', 'blocked', 'error'],
      additionalProperties: false,
    },
  };
  const tools: NativeTool[] = [{ type: 'programmatic_tool_calling' }, syntheticDisallowedTool];
  let first;
  try {
    first = await withMutedRuntimeLogs(() => createNativeResponse({
      instructions: 'Use one hosted program to call sde_sql exactly once. After its output, stop and return a short final answer. Never retry.',
      items: [toNativeMessage('Run the one bounded programmatic call requested by the instructions.')],
      tools,
      parallelToolCalls: true,
      truncation: 'auto',
    }));
  } catch {
    first = null;
  }
  const originalCalls = first ? extractFunctionCalls(first.output) : [];
  const originalCall = originalCalls.length === 1 ? originalCalls[0] : null;
  const chatId = 992000000 + Math.floor(Math.random() * 100000);
  const threadId = `ptc-negative-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const prompt = 'Run the bounded negative programmatic policy scenario.';
  db.prepare('INSERT OR IGNORE INTO telegram_sessions (chat_id, username) VALUES (?, ?)').run(chatId, 'ptc_negative');
  db.prepare('INSERT INTO agent_threads (thread_id, chat_id, user_id) VALUES (?, ?, ?)').run(threadId, chatId, 0);
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'user', prompt);
  const activity: AgentActivityEvent[] = [];
  let result: { text: string; peakInputTokens: number } | null = null;
  let structuredRejectionValid = false;
  let structuredRejectionLinkageValid = false;
  let structuredRejectionChars: number[] = [];
  if (first) {
    let firstResponsePending = true;
    try {
      result = await withMutedRuntimeLogs(() => runWithActivitySink(
        { emit: (event) => activity.push(event) },
        () => __test__.runNativeAgentLoop(
          db,
          threadId,
          { userId: 0, chatId },
          prompt,
          'The application policy is authoritative. After a blocked tool output, return a short final answer and do not retry.',
          () => 'The application policy is authoritative. After a blocked tool output, return a short final answer and do not retry.',
          async (input) => {
            if (firstResponsePending) {
              firstResponsePending = false;
              return first;
            }
            const functionOutputs = input.items.filter((item) => item.type === 'function_call_output');
            if (functionOutputs.length === 1) {
              const functionOutput = functionOutputs[0]!;
              const serialized = functionOutput.output;
              structuredRejectionChars = [serialized.length];
              structuredRejectionLinkageValid = originalCall !== null
                && functionOutput.call_id === originalCall.callId
                && sameExactProgramCaller(functionOutput.caller, originalCall.caller);
              try {
                const parsed = JSON.parse(serialized) as unknown;
                structuredRejectionValid = isExactStructuredPolicyRejection(parsed);
              } catch {
                structuredRejectionValid = false;
              }
            }
            return createNativeResponse({ ...input, tools });
          },
        ),
      ));
    } catch {
      result = null;
    }
  }
  const batches = activity.filter(
    (event): event is Extract<AgentActivityEvent, { type: 'programmatic_tool_batch' }> =>
      event.type === 'programmatic_tool_batch',
  );
  const accepted = batches.reduce((sum, event) => sum + event.accepted, 0);
  const rejected = batches.reduce((sum, event) => sum + event.rejected, 0);
  const audits = readSafeToolAudits(db, threadId);
  const audit = audits.length === 1 ? audits[0] : null;
  const finalObserved = activity.some((event) => event.type === 'final_assistant_message');
  const dispatchObserved = activity.some((event) => event.type === 'tool_start');
  const passed = result !== null
    && accepted === 0
    && rejected === 1
    && !dispatchObserved
    && finalObserved
    && structuredRejectionValid
    && structuredRejectionLinkageValid
    && audit?.tool === 'sde_sql'
    && audit.result.ok === false
    && audit.result.blocked === true
    && audit.result.schema_valid === false;
  return {
    scenario_id: 'hosted-negative-sde-sql',
    passed,
    source_category: 'OpenAI hosted program plus application policy gate',
    elapsed_milliseconds: Date.now() - started,
    model_iteration_count: activity.filter((event) => event.type === 'model_turn').length,
    ...(result ? { peak_input_tokens: result.peakInputTokens } : {}),
    eligible_tool_names: [],
    accepted_programmatic_batch_count: 0,
    accepted_programmatic_call_count: 0,
    rejected_programmatic_call_count: rejected,
    local_output_character_counts: structuredRejectionChars,
    final_answer_character_count: result?.text.length ?? 0,
    schema_validation: structuredRejectionValid,
  };
}

function isExactStructuredPolicyRejection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3
    && record.ok === false
    && record.blocked === true
    && typeof record.error === 'string'
    && record.error.length > 0;
}

function sameExactProgramCaller(left: unknown, right: unknown): boolean {
  if (!isExactProgramCaller(left) || !isExactProgramCaller(right)) return false;
  return left.type === right.type && left.caller_id === right.caller_id;
}

function isExactProgramCaller(value: unknown): value is { type: 'program'; caller_id: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && record.type === 'program'
    && typeof record.caller_id === 'string'
    && record.caller_id.length > 0;
}

async function runHostedScenario(
  db: Database.Database,
  scenarioId: string,
  prompt: string,
  expectedTool: string,
  expectedAccepted: number,
  negative: boolean,
): Promise<Record<string, unknown>> {
  const chatId = 991000000 + Math.floor(Math.random() * 100000);
  const threadId = `ptc-matrix-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  db.prepare('INSERT OR IGNORE INTO telegram_sessions (chat_id, username) VALUES (?, ?)').run(chatId, 'ptc_matrix');
  db.prepare('INSERT INTO agent_threads (thread_id, chat_id, user_id) VALUES (?, ?, ?)').run(threadId, chatId, 0);
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'user', prompt);
  const activity: AgentActivityEvent[] = [];
  const started = Date.now();
  let result: { text: string; peakInputTokens: number } | null = null;
  try {
    result = await withMutedRuntimeLogs(() => runWithActivitySink(
      { emit: (event) => activity.push(event) },
      () => handleAgentMessage(db, threadId, { userId: 0, chatId }, prompt),
    ));
  } catch {
    result = null;
  }
  const batches = activity.filter(
    (event): event is Extract<AgentActivityEvent, { type: 'programmatic_tool_batch' }> =>
      event.type === 'programmatic_tool_batch',
  );
  const accepted = batches.reduce((sum, event) => sum + event.accepted, 0);
  const rejected = batches.reduce((sum, event) => sum + event.rejected, 0);
  const iterations = activity.filter((event) => event.type === 'model_turn').length;
  const finalObserved = activity.some((event) => event.type === 'final_assistant_message');
  const audits = readSafeToolAudits(db, threadId);
  const eligibleAudits = audits.filter((audit) => audit.result.schema_valid === true);
  const localChars = eligibleAudits.flatMap((audit) =>
    typeof audit.result.output_chars === 'number' ? [audit.result.output_chars] : []);
  const positivePassed = !negative
    && result !== null
    && finalObserved
    && accepted === expectedAccepted
    && rejected === 0
    && audits.length === expectedAccepted
    && eligibleAudits.length === expectedAccepted
    && eligibleAudits.every((audit) => audit.tool === expectedTool && audit.result.ok === true)
    && localChars.every((size) => size <= 12_000);
  const negativePassed = negative
    && result !== null
    && finalObserved
    && accepted === 0
    && rejected > 0
    && !activity.some((event) => event.type === 'tool_start')
    && audits.every((audit) => audit.result.ok !== true);
  return {
    scenario_id: scenarioId,
    passed: negative ? negativePassed : positivePassed,
    source_category: 'OpenAI hosted program',
    elapsed_milliseconds: Date.now() - started,
    model_iteration_count: iterations,
    ...(result ? { peak_input_tokens: result.peakInputTokens } : {}),
    eligible_tool_names: [...new Set(eligibleAudits.map((audit) => audit.tool))],
    accepted_programmatic_batch_count: batches.filter((batch) => batch.accepted > 0).length,
    accepted_programmatic_call_count: accepted,
    rejected_programmatic_call_count: rejected,
    local_output_character_counts: localChars,
    final_answer_character_count: result?.text.length ?? 0,
    schema_validation: eligibleAudits.every((audit) => audit.result.schema_valid === true),
  };
}

type DynamicSmokeSample = { typeId: number; itemId: number; attributeIds: number[] };

function readDynamicSmokeSamples(): DynamicSmokeSample[] {
  const raw = process.env.EVE_TOOL_SMOKE_DYNAMIC_SAMPLES?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 2) return [];
    return parsed.flatMap((value): DynamicSmokeSample[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const sample = value as Record<string, unknown>;
      if (!Number.isSafeInteger(sample.type_id) || Number(sample.type_id) <= 0
        || !Number.isSafeInteger(sample.item_id) || Number(sample.item_id) <= 0
        || !Array.isArray(sample.attribute_ids)
        || sample.attribute_ids.length < 1
        || sample.attribute_ids.length > 10
        || sample.attribute_ids.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0)
        || new Set(sample.attribute_ids).size !== sample.attribute_ids.length) return [];
      return [{
        typeId: Number(sample.type_id),
        itemId: Number(sample.item_id),
        attributeIds: sample.attribute_ids.map(Number),
      }];
    });
  } catch {
    return [];
  }
}

function readSafeToolAudits(
  db: Database.Database,
  threadId: string,
): Array<{ tool: string; result: Record<string, unknown> }> {
  const rows = db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool' ORDER BY id").all(threadId) as Array<{ content: string }>;
  return rows.flatMap((row) => {
    try {
      const parsed = JSON.parse(row.content) as { tool?: unknown; result?: unknown };
      if (typeof parsed.tool !== 'string' || !parsed.result || typeof parsed.result !== 'object' || Array.isArray(parsed.result)) return [];
      return [{ tool: parsed.tool, result: parsed.result as Record<string, unknown> }];
    } catch {
      return [];
    }
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}

async function runDirectToolSmoke(db: Database.Database): Promise<void> {
  const sql = `
    SELECT
      t.type_id,
      t.name AS type_name,
      g.name AS group_name,
      c.name AS category_name,
      json_extract(t.data_json, '$.mass') AS mass
    FROM sde_types t
    JOIN sde_groups g ON g.group_id = t.group_id
    JOIN sde_categories c ON c.category_id = g.category_id
    WHERE lower(t.name) = lower('Raven')
    LIMIT 1
  `;
  const result = await __test__.executeToolCall(
    db,
    'smoke-direct',
    'Verify Raven SDE lookup',
    { userId: 0, chatId: 0 },
    'sde_sql',
    { sql },
    { normalizedQueries: [], eveKillCallCount: 0 },
  ) as unknown;
  console.log(JSON.stringify({
    ok: true,
    mode: 'direct',
    tool_names: ['sde_sql'],
    result,
  }, null, 2));
}

async function runAgentToolSmoke(db: Database.Database): Promise<void> {
  const chatId = Number(process.env.EVE_TOOL_SMOKE_CHAT_ID || 990000001);
  const threadId = `tool-smoke-${Date.now()}`;
  db.prepare('INSERT OR IGNORE INTO telegram_sessions (chat_id, username) VALUES (?, ?)').run(chatId, 'tool_smoke');
  db.prepare('INSERT INTO agent_threads (thread_id, chat_id, user_id) VALUES (?, ?, ?)').run(threadId, chatId, 0);

  const prompt = process.env.EVE_TOOL_SMOKE_PROMPT
    || 'Проверь через локальную SDE: найди корабль Raven, его type_id, group/category и массу. Обязательно используй tool, не отвечай по памяти. Ответь кратко по-русски.';

  // Mirror the real chat pipeline: the user message is stored before the agent runs.
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'user', prompt);

  const programmaticEnabled = process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING?.trim().toLowerCase() === 'true';
  const activity: AgentActivityEvent[] = [];
  const runAgent = () => runWithActivitySink(
    { emit: (event) => activity.push(event) },
    () => handleAgentMessage(db, threadId, { userId: 0, chatId }, prompt),
  );
  const result = programmaticEnabled
    ? await withMutedRuntimeLogs(runAgent)
    : await runAgent();
  const toolRows = db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool' ORDER BY id").all(threadId) as Array<{ content: string }>;
  const toolNames = toolRows.map((row) => {
    try {
      const parsed = JSON.parse(row.content) as { tool?: unknown };
      return typeof parsed.tool === 'string' ? parsed.tool : 'unknown';
    } catch {
      return 'unparseable';
    }
  });

  if (toolNames.length === 0) {
    fail('Agent completed without recording any tool calls.');
  }

  const programmaticBatches = activity.filter(
    (event): event is Extract<AgentActivityEvent, { type: 'programmatic_tool_batch' }> =>
      event.type === 'programmatic_tool_batch',
  );
  const acceptedProgrammaticCalls = programmaticBatches.reduce((sum, event) => sum + event.accepted, 0);
  const rejectedProgrammaticCalls = programmaticBatches.reduce((sum, event) => sum + event.rejected, 0);
  if (programmaticEnabled && acceptedProgrammaticCalls === 0) {
    fail('Programmatic Tool Calling was enabled, but no accepted programmatic function call was observed.');
  }

  const report: Record<string, unknown> = {
    ok: true,
    mode: 'agent',
    tool_count: toolNames.length,
    tool_names: toolNames,
    peak_input_tokens: result.peakInputTokens,
  };
  if (programmaticEnabled) {
    report.programmatic_batch_count = programmaticBatches.length;
    report.programmatic_call_count = acceptedProgrammaticCalls;
    report.programmatic_rejection_count = rejectedProgrammaticCalls;
    report.answer_chars = result.text.length;
  } else {
    report.thread_id = threadId;
    report.answer_preview = result.text.slice(0, 1000);
  }
  console.log(JSON.stringify(report, null, 2));
}

async function withMutedRuntimeLogs<T>(fn: () => Promise<T>): Promise<T> {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
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
