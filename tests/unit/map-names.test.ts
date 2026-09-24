import { beforeEach, describe, expect, it, vi } from 'vitest';

const callEsiOperationMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
}));

import { resetNameCacheForTests, resolveCharacterNames } from '../../src/eve-map/names.js';
import type { Db } from '../../src/db/sqlite.js';

const db = {} as Db;

beforeEach(() => {
  callEsiOperationMock.mockReset();
  resetNameCacheForTests();
});

describe('resolveCharacterNames', () => {
  it('posts ids as the JSON `ids` body parameter that the ESI client expects', async () => {
    callEsiOperationMock.mockResolvedValueOnce({
      ok: true, status: 200, cached: false, headers: {},
      data: [{ id: 91, name: 'Pilot One', category: 'character' }],
    });

    const names = await resolveCharacterNames(db, [91, 92, -1]);

    expect(callEsiOperationMock).toHaveBeenCalledWith(
      db, 'post_universe_names', { ids: JSON.stringify([91, 92]) }, null,
    );
    expect(names.get(91)).toBe('Pilot One');
    expect(names.has(92)).toBe(false);
  });

  it('serves cached names without another ESI call and survives failures', async () => {
    callEsiOperationMock.mockResolvedValueOnce({
      ok: true, status: 200, cached: false, headers: {}, data: [{ id: 5, name: 'Cached' }],
    });
    await resolveCharacterNames(db, [5]);
    callEsiOperationMock.mockRejectedValueOnce(new Error('boom'));

    const names = await resolveCharacterNames(db, [5, 6]);

    expect(names.get(5)).toBe('Cached');
    expect(callEsiOperationMock).toHaveBeenCalledTimes(2);
    expect(callEsiOperationMock.mock.calls[1]?.[2]).toEqual({ ids: JSON.stringify([6]) });
  });
});
