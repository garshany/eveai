/**
 * Live latency bench for the agent loop. Drives the REAL agent path
 * (runAgentTurn -> handleAgentMessage -> ModelHub /v1/responses) against the
 * LOCAL SQLite database — it never talks to a production deployment. The
 * provider key is read from .env by src/config.ts as usual; it is neither
 * hardcoded nor printed here.
 *
 *   tsx scripts/agent-latency-bench.ts [--runs 3] [--only <id>] [--db <path>] [--json]
 *
 * Prompts live in agent-latency-bench.prompts.ts. Each prompt runs N times
 * (default 3) on a fresh thread; the report carries per-run wall time,
 * iteration count, token totals and the final text, plus per-prompt medians,
 * as JSON and a human table. Metrics are parsed from the executor's
 * structured `[executor]` log lines — the same lines used for production
 * latency analysis — so the harness needs no instrumentation inside src/.
 * Provider latency variance is huge; never compare single runs, compare
 * medians between two bench invocations.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { format } from 'node:util';
import { config } from '../src/config.js';
import { initDb, type Db } from '../src/db/sqlite.js';
import { runMigrations } from '../src/db/migrations.js';
import { ensureChatSessionRow, runAgentTurn } from '../src/chat/shared.js';
import { acquireRuntimeLock } from '../src/runtime/process-lock.js';
import type { UserContext } from '../src/auth/user-resolver.js';
import { LATENCY_BENCH_PROMPTS, type LatencyBenchPrompt } from './agent-latency-bench.prompts.js';

const BENCH_CHAT_ID = 0;
const BENCH_DISPLAY_NAME = 'LatencyBench';

type BenchArgs = {
  runs: number;
  only: string | null;
  dbPath: string;
  json: boolean;
};

type TurnTokens = {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
};

type BenchRun = {
  run: number;
  wallMs: number;
  status: 'ok' | 'error';
  iterations: number | null;
  tokens: TurnTokens | null;
  finalText: string | null;
  error: string | null;
};

function parseArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = { runs: 3, only: null, dbPath: config.db.path, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--runs') {
      args.runs = Number.parseInt(argv[++index] ?? '', 10);
      if (!Number.isFinite(args.runs) || args.runs < 1) throw new Error('--runs must be a positive integer');
    } else if (arg === '--only') {
      args.only = argv[++index] ?? null;
      if (!args.only) throw new Error('--only requires a prompt id');
    } else if (arg === '--db') {
      args.dbPath = argv[++index] ?? '';
      if (!args.dbPath) throw new Error('--db requires a path');
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx scripts/agent-latency-bench.ts [--runs 3] [--only <id>] [--db <path>] [--json]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** Reuse one bench user so repeated benches do not pile up identity rows. */
function getOrCreateBenchUser(db: Db): number {
  const existing = db.prepare(
    'SELECT user_id FROM users WHERE display_name = ? ORDER BY user_id LIMIT 1',
  ).get(BENCH_DISPLAY_NAME) as { user_id: number } | undefined;
  if (existing) return existing.user_id;
  const result = db.prepare(
    "INSERT INTO users (display_name, created_at, updated_at) VALUES (?, datetime('now'), datetime('now'))",
  ).run(BENCH_DISPLAY_NAME);
  return Number(result.lastInsertRowid);
}

/** Route the executor's console.log chatter into a buffer for later parsing. */
function captureConsoleLog(lines: string[]): () => void {
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(format(...args));
  };
  return () => {
    console.log = original;
  };
}

const DONE_RE = /\[executor\] === DONE \(([\w-]+)\)(?: iterations=(\d+))? total_in=(\d+) total_out=(\d+) total_cached=(\d+) total_cache_write=(\d+) total_reasoning=(\d+)/;
const ITER_RE = /\[executor\] iter=(\d+) tokens:/;

function parseTurnLogs(lines: string[]): { iterations: number | null; tokens: TurnTokens | null } {
  let done: RegExpMatchArray | null = null;
  let maxIter = -1;
  for (const line of lines) {
    const doneMatch = line.match(DONE_RE);
    if (doneMatch) done = doneMatch;
    const iterMatch = line.match(ITER_RE);
    if (iterMatch) maxIter = Math.max(maxIter, Number.parseInt(iterMatch[1]!, 10));
  }
  if (!done) {
    return { iterations: maxIter >= 0 ? maxIter + 1 : null, tokens: null };
  }
  return {
    iterations: done[2] !== undefined ? Number.parseInt(done[2], 10) : (maxIter >= 0 ? maxIter + 1 : null),
    tokens: {
      input: Number.parseInt(done[3]!, 10),
      output: Number.parseInt(done[4]!, 10),
      cached: Number.parseInt(done[5]!, 10),
      cacheWrite: Number.parseInt(done[6]!, 10),
      reasoning: Number.parseInt(done[7]!, 10),
    },
  };
}

async function runOnce(db: Db, ctx: UserContext, prompt: LatencyBenchPrompt, runIndex: number): Promise<BenchRun> {
  // A fresh thread per run: stateless mode resends thread history every
  // iteration, so reusing a thread would skew later repetitions upward.
  // Create the row up front (as resolveThreadForChat does for chat lanes) —
  // runAgentTurn writes the user message before the executor can adopt an
  // unknown thread id.
  const threadId = randomUUID();
  db.prepare(
    'INSERT INTO agent_threads (thread_id, chat_id, character_id, user_id) VALUES (?, ?, NULL, ?)',
  ).run(threadId, ctx.chatId ?? BENCH_CHAT_ID, ctx.userId);
  const lines: string[] = [];
  const restore = captureConsoleLog(lines);
  const started = performance.now();
  let finalText: string | null = null;
  let error: string | null = null;
  try {
    finalText = await runAgentTurn(db, threadId, ctx, prompt.text, { backgroundProfileRefresh: false });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    restore();
  }
  const wallMs = Math.round(performance.now() - started);
  const { iterations, tokens } = parseTurnLogs(lines);
  return {
    run: runIndex,
    wallMs,
    status: error === null ? 'ok' : 'error',
    iterations,
    tokens,
    finalText,
    error,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function medianOf<T>(runs: BenchRun[], pick: (run: BenchRun) => T | null, map: (value: T) => number): number | null {
  return median(runs.map(pick).filter((value): value is T => value !== null).map(map));
}

function buildMedian(runs: BenchRun[]) {
  const okRuns = runs.filter((run) => run.status === 'ok');
  return {
    wall_ms: median(okRuns.map((run) => run.wallMs)),
    iterations: medianOf(okRuns, (run) => run.iterations, (value) => value),
    tokens_input: medianOf(okRuns, (run) => run.tokens, (tokens) => tokens.input),
    tokens_output: medianOf(okRuns, (run) => run.tokens, (tokens) => tokens.output),
    tokens_cached: medianOf(okRuns, (run) => run.tokens, (tokens) => tokens.cached),
    tokens_cache_write: medianOf(okRuns, (run) => run.tokens, (tokens) => tokens.cacheWrite),
    tokens_reasoning: medianOf(okRuns, (run) => run.tokens, (tokens) => tokens.reasoning),
  };
}

function fmt(value: number | null, digits = 0): string {
  return value === null ? '-' : value.toFixed(digits);
}

function printTable(report: { prompts: Array<{ id: string; runs: BenchRun[]; median: ReturnType<typeof buildMedian> }> }): void {
  const header = ['prompt', 'ok', 'wall_s', 'iters', 'in_tok', 'out_tok', 'cached', 'reasoning'];
  const rows = report.prompts.map((entry) => [
    entry.id,
    `${entry.runs.filter((run) => run.status === 'ok').length}/${entry.runs.length}`,
    entry.median.wall_ms === null ? '-' : (entry.median.wall_ms / 1000).toFixed(1),
    fmt(entry.median.iterations),
    fmt(entry.median.tokens_input),
    fmt(entry.median.tokens_output),
    fmt(entry.median.tokens_cached),
    fmt(entry.median.tokens_reasoning),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  const render = (cells: string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd();
  console.log(render(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(render(row));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prompts = args.only
    ? LATENCY_BENCH_PROMPTS.filter((prompt) => prompt.id === args.only)
    : LATENCY_BENCH_PROMPTS;
  if (prompts.length === 0) {
    throw new Error(`No bench prompt with id "${args.only}". Known ids: ${LATENCY_BENCH_PROMPTS.map((prompt) => prompt.id).join(', ')}`);
  }

  const runtimeLock = acquireRuntimeLock(args.dbPath, 'agent latency bench');
  const db = initDb(args.dbPath);
  try {
    runMigrations(db);
    // agent_threads.chat_id references telegram_sessions, so the bench lane
    // needs its session row before any thread is created.
    ensureChatSessionRow(db, BENCH_CHAT_ID, BENCH_DISPLAY_NAME);
    const ctx: UserContext = {
      userId: getOrCreateBenchUser(db),
      chatId: BENCH_CHAT_ID,
      notificationCapability: 'none',
    };

    const promptReports = [];
    for (const prompt of prompts) {
      const runs: BenchRun[] = [];
      // Sequential on purpose: concurrent runs would contend on the provider
      // admission queue and pollute each other's wall clock.
      for (let runIndex = 1; runIndex <= args.runs; runIndex += 1) {
        runs.push(await runOnce(db, ctx, prompt, runIndex));
      }
      promptReports.push({ id: prompt.id, text: prompt.text, runs, median: buildMedian(runs) });
    }

    const report = {
      schema_version: 1,
      mode: 'live',
      generated_at: new Date().toISOString(),
      provider: config.openai.providerId,
      model: config.openai.model,
      db_path: args.dbPath,
      response_state_mode: config.openai.responseStateMode,
      reasoning_effort: {
        base: config.openai.reasoningEffort,
        intermediate: config.openai.reasoningEffortIntermediate,
        final: config.openai.reasoningEffortFinal,
      },
      runs_per_prompt: args.runs,
      prompts: promptReports,
    };

    if (!args.json) {
      console.log(`Agent latency bench: ${prompts.length} prompts x ${args.runs} runs, provider=${report.provider} model=${report.model} db=${report.db_path}`);
      printTable(report);
      for (const entry of promptReports) {
        const failed = entry.runs.filter((run) => run.status === 'error');
        for (const run of failed) {
          console.log(`ERROR ${entry.id} run=${run.run}: ${run.error?.slice(0, 160)}`);
        }
      }
    }
    console.log(JSON.stringify(report));
    if (promptReports.some((entry) => entry.runs.some((run) => run.status === 'error'))) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
    runtimeLock.release();
  }
}

await main();
