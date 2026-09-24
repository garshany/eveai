import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BubblePayload, BubbleSystem } from '../../src/eve-map/bubble.js';
import type { Advisory } from '../../src/eve-map/advisor.js';
import type { IndexedKill } from '../../src/eve-map/kill-index.js';

const { createNativeResponseMock } = vi.hoisted(() => ({ createNativeResponseMock: vi.fn() }));
vi.mock('../../src/agent/native-responses.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/native-responses.js')>();
  return { ...actual, createNativeResponse: createNativeResponseMock };
});

import {
  buildSituationFacts,
  composeSituationAssessment,
  sanitizeAssessment,
  type SituationInput,
} from '../../src/eve-map/advisor-prose.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function system(systemId: number, name: string, extra: Partial<BubbleSystem> = {}): BubbleSystem {
  return {
    systemId, name, jumps: 1, security: 0.5, securityClass: null, regionId: 1, regionName: 'The Forge',
    mapX: 0, mapY: 0, whClass: null,
    activity: {
      systemId, kills15m: 0, kills1h: 0, killsWindow: 0, killsWindowHours: 3, pvpKills1h: 0, npcKills1h: 0,
      valueDestroyed1h: 0, soloKills1h: 0, lastKillMinutesAgo: null, lastKillAtMs: null,
    },
    baselineShipKills: 0, baselineNpcKills: 0, baselineJumps: 0,
    sovereigntyAllianceId: null, sovereigntyFactionId: null, gateCamps: [],
    danger: { systemId, score: 0, band: 'calm', terms: [] },
    ...extra,
  } as BubbleSystem;
}

function kill(extra: Partial<IndexedKill>): IndexedKill {
  return {
    killmailId: 1, systemId: 2, regionId: 1, killmailTime: null, killmailTimeMs: NOW - 3 * 60_000,
    totalValue: 250_000_000, attackerCount: 5, isNpc: false, isSolo: false,
    victimShipTypeId: 1, victimShipName: 'Iteron Mark V', victimShipGroupName: 'Industrial',
    victimCharacterId: null, victimCharacterName: null, victimCorporationName: null,
    finalBlowCharacterId: 7, finalBlowCharacterName: 'Gank Pilot', finalBlowShipTypeId: 2,
    finalBlowShipName: 'Tornado', position: null, gateId: 50000001,
    ...extra,
  };
}

const advisory: Advisory = {
  rule: 'camp_next_hop', severity: 'danger',
  text: { ru: 'Кемп на следующем гейте: Uedama.', en: 'Camp on the next gate: Uedama.' },
  systemId: 2, killmailId: 1, repeats: 0, stateKey: 'camp:2', at: new Date(NOW).toISOString(),
};

function input(extra: Partial<SituationInput> = {}): SituationInput {
  const bubble = {
    originId: 1, radius: 3, requestedRadius: 3, truncated: false,
    systems: [
      system(1, 'Sivala', { jumps: 0, security: 0.6 }),
      system(2, 'Uedama', {
        security: 0.5,
        danger: { systemId: 2, score: 0.82, band: 'hot', terms: [] },
        activity: {
          systemId: 2, kills15m: 3, kills1h: 7, killsWindow: 20, killsWindowHours: 3, pvpKills1h: 7, npcKills1h: 0,
          valueDestroyed1h: 0, soloKills1h: 0, lastKillMinutesAgo: 3, lastKillAtMs: NOW - 180_000,
        },
      }),
      system(3, 'Niarja', { jumps: 2 }),
    ],
    edges: [], wormholes: [],
    recentKills: [kill({}), kill({ killmailId: 2, isNpc: true, victimShipName: 'NPC Rat' })],
    verdict: { score: 0.6, band: 'warn', worstSystemId: 2 },
    pilotShip: { shipName: 'Iteron Mark V', shipClass: 'Industrial', ehp: 18_000, alignTime: 12, survivalChance: 'low' },
    freshness: [], builtAt: new Date(NOW).toISOString(),
  } as unknown as BubblePayload;
  return { advisories: [advisory], bubble, currentSystemId: 1, routeAhead: [2, 3], locale: 'ru', now: NOW, ...extra };
}

beforeEach(() => createNativeResponseMock.mockReset());

describe('perimeter situation assessment', () => {
  it('builds a fact sheet from the radar picture only', () => {
    const facts = buildSituationFacts(input());
    expect(facts).toContain('Pilot position: Sivala (sec 0.6, The Forge)');
    expect(facts).toContain('Iteron Mark V (Industrial');
    expect(facts).toContain('Кемп на следующем гейте: Uedama.');
    expect(facts).toContain('- Uedama: 1 jumps away, sec 0.5, danger hot (82%), kills 15m/1h 3/7');
    expect(facts).toContain('3 min ago in Uedama on a gate: Iteron Mark V killed by Gank Pilot in Tornado, 5 attackers, 250M ISK');
    expect(facts).toContain('Active route ahead: Uedama → Niarja');
    // NPC kills are noise for a threat picture.
    expect(facts).not.toContain('NPC Rat');
  });

  it('returns the model assessment, billed and capped at low effort', async () => {
    createNativeResponseMock.mockResolvedValue({
      outputText: '## Оценка\nUedama под кемпом, индус не переживёт.\nОставайся в Sivala.',
      error: null, status: 'completed', usage: { input: 400, output: 60, cached: 0, reasoning: 20 },
    });
    const onUsage = vi.fn();
    const text = await composeSituationAssessment(input({ onUsage }));
    expect(text).toBe('Оценка Uedama под кемпом, индус не переживёт. Оставайся в Sivala.');
    expect(onUsage).toHaveBeenCalledWith({ input: 400, output: 60, cached: 0, reasoning: 20 });
    const request = createNativeResponseMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({ tools: [], reasoningEffort: 'low', maxOutputTokens: 700 });
    expect(String(request.instructions)).toContain('Ничего не выдумывай');
  });

  it('answers null (rule text stands alone) on failures, and still bills a failed call', async () => {
    const onUsage = vi.fn();
    createNativeResponseMock.mockResolvedValueOnce({
      outputText: '', error: { message: 'boom' }, status: 'failed', usage: { input: 10, output: 0, cached: 0, reasoning: 0 },
    });
    await expect(composeSituationAssessment(input({ onUsage }))).resolves.toBeNull();
    expect(onUsage).toHaveBeenCalledTimes(1);

    createNativeResponseMock.mockRejectedValueOnce(new Error('network down'));
    await expect(composeSituationAssessment(input())).resolves.toBeNull();

    await expect(composeSituationAssessment(input({ advisories: [] }))).resolves.toBeNull();
    expect(createNativeResponseMock).toHaveBeenCalledTimes(2);
  });

  it('caps a rambling answer at a sentence boundary', () => {
    const long = `${'Очень длинное предложение про угрозу. '.repeat(40)}`;
    const capped = sanitizeAssessment(long)!;
    expect(capped.length).toBeLessThanOrEqual(700);
    expect(capped.endsWith('.')).toBe(true);
    expect(sanitizeAssessment('  \n ')).toBeNull();
  });
});
