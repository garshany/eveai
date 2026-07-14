import { describe, expect, it, vi } from 'vitest';

const eveKillMocks = vi.hoisted(() => ({ searchKillmails: vi.fn() }));

vi.mock('../../src/eve-kill/client.js', () => ({
  searchKillmails: eveKillMocks.searchKillmails,
}));

describe('OSINT EVE-KILL activity adapter', () => {
  it('derives attacker and victim roles locally and preserves structured coverage', async () => {
    eveKillMocks.searchKillmails.mockResolvedValue({
      ok: true,
      data: {
        kills: [{
          killmailId: 77,
          killmailTime: '2026-07-12T00:00:00Z',
          solarSystemId: 30000142,
          attackerCount: 1,
          victim: { characterId: 10, corporationId: 20 },
          attackers: [{ characterId: 11, corporationId: 20, finalBlow: true }],
          items: [],
          siblings: [],
          sourceShape: 'esi',
        }],
        truncated: true,
        requestCount: 4,
        windows: [{ from: '2026-07-01T00:00:00Z', to: '2026-07-07T23:59:59Z' }],
      },
    });

    const { fetchEntityActivityHistory } = await import('../../src/eve-osint/activity.js');
    const result = await fetchEntityActivityHistory({} as never, {
      scope: 'corporation',
      id: 20,
      from: '2026-07-01T00:00:00Z',
      to: '2026-07-12T00:00:00Z',
    });

    expect(eveKillMocks.searchKillmails).toHaveBeenCalledWith(
      expect.anything(),
      {
        from: '2026-07-01T00:00:00Z',
        to: '2026-07-12T00:00:00Z',
        corporation_ids: [20],
      },
      { limit: 500 },
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        kills: [{ roles: { attacker: true, victim: true }, killmail_id: 77 }],
        truncated: true,
        requestCount: 4,
      },
    });
  });
});
