// Pinned BEFORE any Date use: the session list renders SQLite's zone-less UTC
// stamps, and on a UTC host a naive Date.parse would agree with the correct
// value — the regression below would pass with the bug reintroduced.
process.env.TZ = 'Europe/Moscow';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatRelativeDay } from '../../web/src/dates.js';

/** SQLite renders datetime('now') as «YYYY-MM-DD HH:MM:SS», UTC, no zone marker. */
function sqlStamp(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('formatRelativeDay', () => {
  it('collapses today to a wall clock in the viewer timezone', () => {
    // 08:07 UTC is 11:07 in Moscow — the label must follow the viewer, and the
    // source stamp must be read as UTC rather than as local time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T18:00:00Z'));
    expect(formatRelativeDay('2026-07-28 08:07:00', 'ru')).toBe('11:07');
  });

  it('names yesterday in each locale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T18:00:00Z'));
    const yesterday = sqlStamp(new Date('2026-07-27T09:00:00Z'));
    expect(formatRelativeDay(yesterday, 'ru')).toBe('вчера');
    expect(formatRelativeDay(yesterday, 'en')).toBe('yesterday');
  });

  it('falls back to a day/month stamp for older sessions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T18:00:00Z'));
    expect(formatRelativeDay('2026-07-26 09:00:00', 'ru')).toBe('26.07');
  });

  it('crosses the day boundary by the viewer calendar, not by 24h arithmetic', () => {
    // 2026-07-27 22:30 UTC is 2026-07-28 01:30 in Moscow: for a Moscow viewer
    // at 03:00 local that is *today*, even though it is 4.5 hours back.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'));
    expect(formatRelativeDay('2026-07-27 22:30:00', 'ru')).toBe('01:30');
  });

  it('returns an empty label for garbage instead of throwing', () => {
    expect(formatRelativeDay('не время', 'en')).toBe('');
  });
});
