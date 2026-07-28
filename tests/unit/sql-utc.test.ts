// Pinned BEFORE any Date use: on a UTC host the buggy Date.parse would give
// the same number as Date.UTC and the regression test below would pass even
// with the viewer-offset bug reintroduced.
process.env.TZ = 'Europe/Moscow';

import { describe, expect, it } from 'vitest';
import { parseSqlUtcDate, parseSqlUtcMs } from '../../web/src/sql-utc.js';

describe('parseSqlUtc', () => {
  it('reads a bare SQLite timestamp as UTC, not local time', () => {
    // Guard: the environment must genuinely be non-UTC, or this test proves
    // nothing — the naive parse has to disagree with the UTC value here.
    expect(Date.parse('2026-07-28 00:30:00')).not.toBe(Date.UTC(2026, 6, 28, 0, 30, 0));
    // Regression: a Moscow (UTC+3) viewer watched the composing timer start at
    // 180:00 because Date.parse read the zone-less stamp as local time.
    expect(parseSqlUtcMs('2026-07-28 00:30:00')).toBe(Date.UTC(2026, 6, 28, 0, 30, 0));
  });

  it('passes ISO timestamps through unchanged', () => {
    expect(parseSqlUtcMs('2026-07-28T00:30:00Z')).toBe(Date.UTC(2026, 6, 28, 0, 30, 0));
    expect(parseSqlUtcDate('2026-07-28T00:30:00.500Z').getTime()).toBe(Date.UTC(2026, 6, 28, 0, 30, 0, 500));
  });

  it('yields NaN for garbage instead of throwing', () => {
    expect(Number.isNaN(parseSqlUtcMs('не время'))).toBe(true);
  });
});
