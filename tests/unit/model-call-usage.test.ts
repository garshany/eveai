import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrations.js';
import { config } from '../../src/config.js';

// Mock only the network boundary: the real call sites must record usage.
const { createNativeResponseMock } = vi.hoisted(() => ({
  createNativeResponseMock: vi.fn(),
}));
vi.mock('../../src/agent/native-responses.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/native-responses.js')>();
  return { ...actual, createNativeResponse: createNativeResponseMock };
});

import { generateRouteIntelSummary, generateThreatAdvice } from '../../src/eve-board/advisor.js';
import { buildRouteThreatDigest } from '../../src/eve-board/analytics.js';
import { analyzeOsintGraphPatterns } from '../../src/eve-osint/llm.js';
import { runWithUsagePayer, SYSTEM_USAGE_USER_ID, type UsagePayer } from '../../src/usage/payer.js';
import type { KillPattern, ShipAssessment, SystemThreatDigest } from '../../src/eve-board/types.js';

let db: Database.Database;
let userId: number;

const USAGE = { input: 200, output: 50, total: 250, cached: 20, cacheWrite: 0, reasoning: 7 };

function completed(outputText: string) {
  return { id: 'r', output: [], outputText, error: null, usage: USAGE, status: 'completed', sawUsefulDeltas: true };
}

function incomplete() {
  return {
    id: 'r',
    output: [],
    outputText: 'partial',
    error: { message: 'max_output_tokens' },
    usage: USAGE,
    status: 'incomplete',
    sawUsefulDeltas: true,
  };
}

function events(): Array<Record<string, unknown>> {
  return db.prepare(
    'SELECT user_id, thread_id, channel, model, input_tokens, output_tokens, cached_tokens, reasoning_tokens FROM usage_events',
  ).all() as Array<Record<string, unknown>>;
}

function expectedRow(payerUserId: number, threadId: string, channel: string) {
  return {
    user_id: payerUserId,
    thread_id: threadId,
    channel,
    model: config.openai.model,
    input_tokens: 200,
    output_tokens: 50,
    cached_tokens: 20,
    reasoning_tokens: 7,
  };
}

beforeEach(() => {
  createNativeResponseMock.mockReset();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  userId = Number(db.prepare("INSERT INTO users (display_name) VALUES ('capsuleer')").run().lastInsertRowid);
});

afterEach(() => {
  db.close();
});

const SHIP: ShipAssessment = {
  shipTypeId: 123,
  shipName: 'Gila',
  ehp: 13290,
  alignTime: 8.78,
  warpSpeed: 3.0,
  shipClass: 'cruiser',
  isHighValueTarget: false,
  survivalChance: 'UNLIKELY',
};

function system(systemId: number, name: string, jumps: number, level: SystemThreatDigest['threatLevel']): SystemThreatDigest {
  return {
    systemId,
    systemName: name,
    systemSec: 0.5,
    jumpsFromPilot: jumps,
    threatLevel: level,
    reason: 'camp',
    killVelocity: 3,
    activeCamp: level === 'HIGH',
    latestKillMinutes: 2,
    jumpSpike: null,
    gankerCount: 0,
    gateKills: [],
    recentKills: [],
  };
}

function hotDigest() {
  return buildRouteThreatDigest(
    'Uedama', 1, 3, 'Dodixie', 'Jita',
    [system(30002768, 'Uedama', 0, 'HIGH'), system(30000142, 'Jita', 1, 'LOW')],
    [system(30002659, 'Dodixie', -1, 'LOW')],
  );
}

const MONITOR = { routeSystems: [30002659, 30002768, 30000142], originId: 30002659, destinationId: 30000142, currentSystemId: 30002768 };

const PATTERN = {
  systemId: 30002768,
  systemName: 'Uedama',
  systemSec: 0.5,
  killCount: 4,
  timeWindowMinutes: 15,
  uniqueAttackers: new Set([1, 2, 3]),
  attackerShipTypes: new Map<number, number>(),
  victimShipGroups: ['hauler'],
  estimatedGankDps: 9000,
  isNpcOnly: false,
  latestKillTime: new Date().toISOString(),
} satisfies KillPattern;

describe('route advisor usage accounting', () => {
  it('bills a route-intel model call to the monitor lane on the config model, with a real abort signal', async () => {
    createNativeResponseMock.mockResolvedValue(completed('not json'));
    const payer: UsagePayer = { db, userId, chatId: 42, threadId: 'route-monitor' };

    await generateRouteIntelSummary(hotDigest(), SHIP, null, [], MONITOR, payer);

    expect(createNativeResponseMock).toHaveBeenCalledTimes(1);
    const request = createNativeResponseMock.mock.calls[0]![0] as { model?: string; signal?: AbortSignal };
    expect(request.model).toBe(config.openai.model);
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(events()).toEqual([expectedRow(userId, 'route-monitor', 'telegram')]);
  });

  it('bills a failed/incomplete route-intel response and falls back to the template', async () => {
    createNativeResponseMock.mockResolvedValue(incomplete());
    const payer: UsagePayer = { db, userId: SYSTEM_USAGE_USER_ID, chatId: 42, threadId: 'route-monitor' };

    const summary = await generateRouteIntelSummary(hotDigest(), SHIP, null, [], MONITOR, payer);

    expect(summary.advice).not.toBe('partial');
    expect(events()).toEqual([expectedRow(SYSTEM_USAGE_USER_ID, 'route-monitor', 'telegram')]);
  });

  it('bills threat advice on success and on an incomplete response', async () => {
    const payer: UsagePayer = { db, userId, chatId: 42, threadId: 'route-monitor' };
    createNativeResponseMock.mockResolvedValueOnce(completed('Стой на гейте.'));
    await expect(generateThreatAdvice(db, PATTERN, { level: 'HIGH', reason: 'camp' }, SHIP, 'Sivala', 1, 'Jita', payer))
      .resolves.toBe('Стой на гейте.');

    createNativeResponseMock.mockResolvedValueOnce(incomplete());
    const fallback = await generateThreatAdvice(db, PATTERN, { level: 'HIGH', reason: 'camp' }, SHIP, 'Sivala', 1, 'Jita', payer);
    expect(fallback).not.toBe('partial');

    expect(events()).toEqual([
      expectedRow(userId, 'route-monitor', 'telegram'),
      expectedRow(userId, 'route-monitor', 'telegram'),
    ]);
  });

  it('records nothing when the call throws before any usage exists', async () => {
    createNativeResponseMock.mockRejectedValue(new Error('Responses API timed out'));
    const payer: UsagePayer = { db, userId, chatId: 42, threadId: 'route-monitor' };
    await generateRouteIntelSummary(hotDigest(), SHIP, null, [], MONITOR, payer);
    expect(events()).toEqual([]);
  });
});

describe('OSINT LLM usage accounting', () => {
  it('bills the ambient turn payer on success', async () => {
    createNativeResponseMock.mockResolvedValue(completed('{"intelligence_summary":"solo hunter"}'));
    const result = await runWithUsagePayer(
      { db, userId, chatId: 7, threadId: 'thread-osint' },
      () => analyzeOsintGraphPatterns({ scope: 'character' }),
    );
    expect(result).toMatchObject({ intelligence_summary: 'solo hunter' });
    const request = createNativeResponseMock.mock.calls[0]![0] as { model?: string; signal?: AbortSignal };
    expect(request.model).toBe(config.openai.model);
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(events()).toEqual([expectedRow(userId, 'thread-osint', 'telegram')]);
  });

  it('bills a failed/incomplete response and discards its partial text', async () => {
    createNativeResponseMock.mockResolvedValue(incomplete());
    const result = await runWithUsagePayer(
      { db, userId, chatId: 7, threadId: 'thread-osint' },
      () => analyzeOsintGraphPatterns({ scope: 'character' }),
    );
    expect(result).toBeNull();
    expect(events()).toEqual([expectedRow(userId, 'thread-osint', 'telegram')]);
  });

  it('keeps concurrent payer scopes isolated', async () => {
    createNativeResponseMock.mockResolvedValue(completed('{"intelligence_summary":"x"}'));
    const other = Number(db.prepare("INSERT INTO users (display_name) VALUES ('other')").run().lastInsertRowid);
    await Promise.all([
      runWithUsagePayer({ db, userId, chatId: 7, threadId: 'a' }, () => analyzeOsintGraphPatterns({})),
      runWithUsagePayer({ db, userId: other, chatId: 8, threadId: 'b' }, () => analyzeOsintGraphPatterns({})),
    ]);
    const rows = db.prepare('SELECT user_id, thread_id FROM usage_events ORDER BY thread_id').all();
    expect(rows).toEqual([{ user_id: userId, thread_id: 'a' }, { user_id: other, thread_id: 'b' }]);
  });
});
