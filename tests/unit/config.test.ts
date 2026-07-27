import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

function setRequiredEnv(): void {
  process.env.OPENAI_API_KEY = 'test';
  process.env.EVE_CLIENT_ID = 'test';
  process.env.EVE_CLIENT_SECRET = 'test';
  process.env.DEFAULT_MARKET_REGION_ID = '10000002';
  process.env.DEFAULT_MARKET_REGION_NAME = 'The Forge';
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('OpenAI runtime configuration', () => {
  it('defaults stored response logs off and parses the opt-in strictly', async () => {
    setRequiredEnv();
    process.env.DOTENV_CONFIG_PATH = '/private/tmp/eveai-test-no-dotenv-file';
    delete process.env.OPENAI_STORE_RESPONSES;
    expect((await import('../../src/config.js')).config.openai.storeResponses).toBe(false);

    vi.resetModules();
    process.env.OPENAI_STORE_RESPONSES = ' TrUe ';
    expect((await import('../../src/config.js')).config.openai.storeResponses).toBe(true);

    vi.resetModules();
    process.env.OPENAI_STORE_RESPONSES = 'yes';
    await expect(import('../../src/config.js')).rejects.toThrow('OPENAI_STORE_RESPONSES');
  });

  it('parses the programmatic tool calling pilot strictly and defaults it off', async () => {
    setRequiredEnv();
    delete process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING;
    expect((await import('../../src/config.js')).config.openai.programmaticToolCalling).toBe(false);

    vi.resetModules();
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = ' TrUe ';
    expect((await import('../../src/config.js')).config.openai.programmaticToolCalling).toBe(true);

    vi.resetModules();
    process.env.OPENAI_PROGRAMMATIC_TOOL_CALLING = 'yes';
    await expect(import('../../src/config.js')).rejects.toThrow('OPENAI_PROGRAMMATIC_TOOL_CALLING');
  });
  it('defaults to OpenAI and ignores a legacy arbitrary base URL override', async () => {
    setRequiredEnv();
    delete process.env.OPENAI_PROVIDER;
    process.env.OPENAI_BASE_URL = 'https://untrusted.example/v1';

    const { config } = await import('../../src/config.js');

    expect(config.openai.providerId).toBe('openai');
    expect(config.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.openai.supportsTruncation).toBe(true);
    expect(config.openai.supportsEncryptedReasoningReplay).toBe(true);
  });

  it('selects the fixed ModelHub Responses endpoint by provider ID', async () => {
    setRequiredEnv();
    process.env.OPENAI_PROVIDER = ' modelhub ';
    process.env.OPENAI_BASE_URL = 'https://untrusted.example/v1';

    const { config } = await import('../../src/config.js');

    expect(config.openai.providerId).toBe('modelhub');
    expect(config.openai.providerName).toBe('ModelHub');
    expect(config.openai.baseUrl).toBe('https://modelhub.my/v1');
    expect(config.openai.responsesTransport).toBe('http_sse');
    expect(config.openai.toolSearchExecution).toBe('client');
    expect(config.openai.supportsHostedProgrammaticToolCalling).toBe(false);
    expect(config.openai.supportsLocalParallelBatch).toBe(true);
    expect(config.openai.supportsTruncation).toBe(false);
    expect(config.openai.supportsEncryptedReasoningReplay).toBe(false);
    expect(config.openai.readSubagentsEnabled).toBe(true);
    expect(config.openai.readSubagentConcurrency).toBe(4);
    expect(config.openai.maxConcurrentEsiLeaves).toBe(12);
  });

  it('hard-bounds nested ESI leaf concurrency', async () => {
    setRequiredEnv();
    process.env.AGENT_MAX_CONCURRENT_ESI_LEAVES = '500';

    expect((await import('../../src/config.js')).config.openai.maxConcurrentEsiLeaves).toBe(64);

    vi.resetModules();
    process.env.AGENT_MAX_CONCURRENT_ESI_LEAVES = '0';
    await expect(import('../../src/config.js')).rejects.toThrow('AGENT_MAX_CONCURRENT_ESI_LEAVES');
  });

  it('allows application-managed read subagents on the OpenAI provider when explicitly enabled', async () => {
    setRequiredEnv();
    process.env.OPENAI_PROVIDER = 'openai';
    process.env.CHEAPVIBE_READ_SUBAGENTS_ENABLED = 'true';

    expect((await import('../../src/config.js')).config.openai.readSubagentsEnabled).toBe(true);
  });

  it('rejects unknown provider IDs instead of accepting arbitrary endpoints', async () => {
    setRequiredEnv();
    process.env.OPENAI_PROVIDER = 'custom-gateway';

    await expect(import('../../src/config.js')).rejects.toThrow(
      'OPENAI_PROVIDER must be one of: openai, modelhub',
    );
  });

  it('rejects server response state on the ModelHub provider', async () => {
    setRequiredEnv();
    process.env.OPENAI_PROVIDER = 'modelhub';
    process.env.OPENAI_RESPONSE_STATE_MODE = 'server';
    process.env.OPENAI_STORE_RESPONSES = 'true';

    await expect(import('../../src/config.js')).rejects.toThrow(
      'ModelHub does not support server-side response state; set OPENAI_RESPONSE_STATE_MODE=stateless',
    );
  });

  it('does not expose an EVE-KILL base override and keeps the client pinned to the current API', async () => {
    setRequiredEnv();
    process.env.EVE_KILL_BASE_URL = 'https://untrusted.invalid/';

    const { config } = await import('../../src/config.js');
    const { EVE_KILL_API_BASE_URL, getEveKillConfig } = await import('../../src/eve-kill/client.js');

    expect(config.eveKill).not.toHaveProperty('baseUrl');
    expect(config.eveKill).not.toHaveProperty('cacheTtlSeconds');
    expect(EVE_KILL_API_BASE_URL).toBe('https://api.eve-kill.com/');
    expect(getEveKillConfig().baseUrl).toBe(EVE_KILL_API_BASE_URL);
    expect('zkill' in config).toBe(false);
  });

  it('hard-bounds positive EVE-KILL timeout, retry, and backoff controls', async () => {
    setRequiredEnv();
    process.env.EVE_KILL_TIMEOUT_MS = '999999999';
    process.env.EVE_KILL_RETRY_MAX_ATTEMPTS = '999999999';
    process.env.EVE_KILL_BACKOFF_MAX_MS = '999999999';

    const { config } = await import('../../src/config.js');

    expect(config.eveKill).toMatchObject({
      timeoutMs: 60_000,
      retryMaxAttempts: 5,
      backoffMaxMs: 60_000,
    });
  });

  it('rejects non-positive EVE-KILL retry controls at startup', async () => {
    for (const name of [
      'EVE_KILL_TIMEOUT_MS',
      'EVE_KILL_RETRY_MAX_ATTEMPTS',
      'EVE_KILL_BACKOFF_MAX_MS',
    ]) {
      setRequiredEnv();
      process.env[name] = '0';
      await expect(import('../../src/config.js')).rejects.toThrow(name);
      delete process.env[name];
      vi.resetModules();
    }
  });

  it('requires stored responses for server-side Responses state', async () => {
    setRequiredEnv();
    process.env.OPENAI_RESPONSE_STATE_MODE = 'server';
    process.env.OPENAI_STORE_RESPONSES = 'false';

    await expect(import('../../src/config.js')).rejects.toThrow(
      'OPENAI_RESPONSE_STATE_MODE=server requires OPENAI_STORE_RESPONSES=true',
    );

    vi.resetModules();
    process.env.OPENAI_STORE_RESPONSES = 'true';
    const { config } = await import('../../src/config.js');
    expect(config.openai.responseStateMode).toBe('server');
    expect(config.openai.storeResponses).toBe(true);
  });

  it('wires the shutdown drain knobs and clamps them to a usable range', async () => {
    setRequiredEnv();
    delete process.env.SHUTDOWN_DRAIN_MS;
    delete process.env.SHUTDOWN_DRAIN_POLL_MS;
    const defaults = (await import('../../src/config.js')).config.shutdown;
    expect(defaults.drainMs).toBe(600_000);
    expect(defaults.drainPollMs).toBe(250);

    vi.resetModules();
    process.env.SHUTDOWN_DRAIN_MS = '5000';
    process.env.SHUTDOWN_DRAIN_POLL_MS = '100';
    const custom = (await import('../../src/config.js')).config.shutdown;
    expect(custom.drainMs).toBe(5_000);
    expect(custom.drainPollMs).toBe(100);

    vi.resetModules();
    process.env.SHUTDOWN_DRAIN_MS = '0'; // documented as "exit immediately"
    expect((await import('../../src/config.js')).config.shutdown.drainMs).toBe(0);

    vi.resetModules();
    // A negative window must not read as a wait at all, and an absurd one must
    // not hold a deploy hostage — but the ceiling must still accept the
    // maximum turn deadline, otherwise a raised deadline cannot be drained.
    process.env.SHUTDOWN_DRAIN_MS = '-1';
    expect((await import('../../src/config.js')).config.shutdown.drainMs).toBe(0);

    vi.resetModules();
    process.env.SHUTDOWN_DRAIN_MS = '99999999';
    expect((await import('../../src/config.js')).config.shutdown.drainMs).toBe(3_600_000);
  });

  it('keeps drain, turn deadline, and the systemd stop timeout consistent', async () => {
    setRequiredEnv();
    delete process.env.SHUTDOWN_DRAIN_MS;
    delete process.env.AGENT_TURN_DEADLINE_MS;
    const { config } = await import('../../src/config.js');
    // A default-length turn must always fit inside the default drain.
    expect(config.shutdown.drainMs).toBeGreaterThanOrEqual(config.openai.turnDeadlineMs);
    // The drain ceiling must accept the turn-deadline ceiling (both 3.6M ms),
    // or a raised AGENT_TURN_DEADLINE_MS could never be drained.
    vi.resetModules();
    process.env.AGENT_TURN_DEADLINE_MS = '99999999';
    process.env.SHUTDOWN_DRAIN_MS = '99999999';
    const clamped = (await import('../../src/config.js')).config;
    expect(clamped.shutdown.drainMs).toBeGreaterThanOrEqual(clamped.openai.turnDeadlineMs);
    // systemd must not SIGKILL mid-drain: TimeoutStopSec stays strictly above
    // the default drain. Reads the shipped unit so the numbers cannot drift.
    const { readFileSync } = await import('node:fs');
    const unit = readFileSync(
      new URL('../../deploy/systemd/eveai.service', import.meta.url),
      'utf8',
    );
    const timeoutStopSec = Number(unit.match(/^TimeoutStopSec=(\d+)$/m)?.[1]);
    expect(Number.isFinite(timeoutStopSec)).toBe(true);
    expect(timeoutStopSec * 1000).toBeGreaterThan(config.shutdown.drainMs);
  });

  it('documents every market snapshot knob in .env.example', async () => {
    // Reads the shipped template so a MARKET_SNAPSHOT_* knob cannot land in
    // config.ts without its .env.example documentation.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../src/config.ts', import.meta.url), 'utf8');
    const knobs = [...new Set(source.match(/MARKET_SNAPSHOT_[A-Z_]+/g) ?? [])].sort();
    expect(knobs).toEqual([
      'MARKET_SNAPSHOT_BATCH_SIZE',
      'MARKET_SNAPSHOT_ENABLED',
      'MARKET_SNAPSHOT_MAJOR_INTERVAL_MINUTES',
      'MARKET_SNAPSHOT_MAJOR_MIN_PAGES',
      'MARKET_SNAPSHOT_MINOR_INTERVAL_MINUTES',
      'MARKET_SNAPSHOT_PAGE_CONCURRENCY',
      'MARKET_SNAPSHOT_STALE_MINUTES',
    ]);
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    for (const knob of knobs) {
      expect(example, knob).toMatch(new RegExp(`^${knob}=`, 'm'));
    }
  });

  it('rejects trust-all proxy mode and parses only explicit trusted CIDRs', async () => {
    setRequiredEnv();
    process.env.WEB_TRUST_PROXY = 'true';
    await expect(import('../../src/config.js')).rejects.toThrow('WEB_TRUSTED_PROXY_CIDRS');

    vi.resetModules();
    delete process.env.WEB_TRUST_PROXY;
    process.env.WEB_TRUSTED_PROXY_CIDRS = '127.0.0.0/8, ::1/128';
    expect((await import('../../src/config.js')).config.web.trustedProxyCidrs)
      .toEqual(['127.0.0.0/8', '::1/128']);
  });

  it('defaults the quality budgets to generous finite values', async () => {
    setRequiredEnv();
    // Keep a stray operator .env from repopulating the knobs under test.
    process.env.DOTENV_CONFIG_PATH = '/private/tmp/eveai-test-no-dotenv-file';
    for (const name of [
      'OPENAI_RESPONSES_TIMEOUT_MS',
      'AGENT_TURN_DEADLINE_MS',
      'WEB_AGENT_DEADLINE_MS',
      'AGENT_MAX_TOOL_OUTPUT_CHARS',
      'AGENT_SMART_AGGREGATE_THRESHOLD',
      'AGENT_MAX_PROGRAMMATIC_TOOL_OUTPUT_CHARS',
      'AGENT_MAX_CONTEXT_MESSAGES',
      'AGENT_MAX_CONTEXT_CHARS',
      'AGENT_MAX_TOOL_ITERATIONS',
      'AGENT_MAX_CONSECUTIVE_SAME_TOOL',
      'AGENT_MAX_CLIENT_SEARCH_CALLS_PER_RESPONSE',
      'AGENT_MAX_EVE_KILL_CALLS_PER_TURN',
      'AGENT_MAX_EVE_KILL_ANALYTICS_CALLS_PER_TURN',
      'AGENT_MAX_TRANSIENT_RETRIES',
      'AGENT_MAX_TOTAL_TURN_READ_LEAVES',
      'CHEAPVIBE_READ_SUBAGENT_MAX_TASKS',
      'CHEAPVIBE_READ_SUBAGENT_MAX_WORKERS',
      'CHEAPVIBE_READ_SUBAGENT_MAX_WORKER_ITERATIONS',
      'CHEAPVIBE_READ_SUBAGENT_MAX_MODEL_CALLS',
      'CHEAPVIBE_READ_SUBAGENT_AGGREGATE_CHARS',
      'CHEAPVIBE_READ_SUBAGENT_BATCH_DEADLINE_MS',
    ]) {
      delete process.env[name];
    }

    const { config } = await import('../../src/config.js');

    expect(config.openai.responsesTimeoutMs).toBe(300_000);
    expect(config.openai.turnDeadlineMs).toBe(600_000);
    expect(config.web.agentDeadlineMs).toBe(600_000);
    expect(config.openai.maxToolOutputChars).toBe(120_000);
    expect(config.openai.smartAggregateThreshold).toBe(200);
    expect(config.openai.maxProgrammaticToolOutputChars).toBe(120_000);
    expect(config.openai.maxContextMessages).toBe(40);
    expect(config.openai.maxContextChars).toBe(100_000);
    expect(config.openai.maxToolIterations).toBe(80);
    expect(config.openai.maxConsecutiveSameTool).toBe(5);
    expect(config.openai.maxClientSearchCallsPerResponse).toBe(8);
    expect(config.openai.maxEveKillCallsPerTurn).toBe(60);
    expect(config.openai.maxEveKillAnalyticsCallsPerTurn).toBe(12);
    expect(config.openai.maxTransientRetries).toBe(5);
    expect(config.openai.maxTotalTurnReadLeaves).toBe(96);
    expect(config.openai.readSubagentMaxTasks).toBe(8);
    expect(config.openai.readSubagentMaxWorkers).toBe(6);
    expect(config.openai.readSubagentMaxWorkerIterations).toBe(8);
    expect(config.openai.readSubagentMaxModelCalls).toBe(24);
    expect(config.openai.readSubagentAggregateChars).toBe(60_000);
    expect(config.openai.readSubagentBatchDeadlineMs).toBe(600_000);
  });

  it('clamps the raised turn deadline ceiling instead of allowing infinity', async () => {
    setRequiredEnv();
    process.env.AGENT_TURN_DEADLINE_MS = '99999999';
    expect((await import('../../src/config.js')).config.openai.turnDeadlineMs).toBe(3_600_000);

    vi.resetModules();
    process.env.AGENT_TURN_DEADLINE_MS = '1000';
    expect((await import('../../src/config.js')).config.openai.turnDeadlineMs).toBe(30_000);

    vi.resetModules();
    process.env.AGENT_TURN_DEADLINE_MS = '0';
    await expect(import('../../src/config.js')).rejects.toThrow('AGENT_TURN_DEADLINE_MS');
  });

  it('parses the per-tool output budget from env and keeps it finite', async () => {
    setRequiredEnv();
    process.env.AGENT_MAX_TOOL_OUTPUT_CHARS = '50000';
    expect((await import('../../src/config.js')).config.openai.maxToolOutputChars).toBe(50_000);

    vi.resetModules();
    process.env.AGENT_MAX_TOOL_OUTPUT_CHARS = '999999999';
    expect((await import('../../src/config.js')).config.openai.maxToolOutputChars).toBe(1_000_000);

    vi.resetModules();
    process.env.AGENT_MAX_TOOL_OUTPUT_CHARS = 'not-a-number';
    await expect(import('../../src/config.js')).rejects.toThrow('AGENT_MAX_TOOL_OUTPUT_CHARS');
  });

  it('parses the read-subagent budgets from env', async () => {
    setRequiredEnv();
    process.env.CHEAPVIBE_READ_SUBAGENT_MAX_TASKS = '12';
    process.env.CHEAPVIBE_READ_SUBAGENT_MAX_MODEL_CALLS = '48';

    const { config } = await import('../../src/config.js');

    expect(config.openai.readSubagentMaxTasks).toBe(12);
    expect(config.openai.readSubagentMaxModelCalls).toBe(48);
  });
});
