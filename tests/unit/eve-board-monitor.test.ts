import { describe, expect, it } from 'vitest';
import { collectNewKillmailIds } from '../../src/eve-board/monitor.js';

describe('eve-board monitor', () => {
  it('deduplicates killmails across polling cycles', () => {
    const seen = new Set<number>([1001]);

    const firstWave = collectNewKillmailIds(seen, [
      { killmail_id: 1001 },
      { killmail_id: 1002 },
      { killmail_id: 1002 },
      { killmail_id: 1003 },
    ]);

    expect([...firstWave]).toEqual([1002, 1003]);
    expect([...seen]).toEqual([1001, 1002, 1003]);

    const secondWave = collectNewKillmailIds(seen, [
      { killmail_id: 1002 },
      { killmail_id: 1004 },
    ]);

    expect([...secondWave]).toEqual([1004]);
    expect([...seen]).toEqual([1001, 1002, 1003, 1004]);
  });
});
