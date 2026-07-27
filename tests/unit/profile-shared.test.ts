import { describe, expect, it } from 'vitest';
import { parseSqlUtc } from '../../web/src/components/profile/shared';

/**
 * Timestamps arrive in two shapes: SQL UTC ('YYYY-MM-DD HH:MM:SS') from
 * character_sync_state and ISO with a zone ('...T...Z') straight from ESI.
 * Appending 'Z' blindly used to NaN the second shape («Выставлен»/«Окончание»
 * always rendered as «—»).
 */
describe('parseSqlUtc', () => {
  it('parses SQL UTC strings, appending the missing zone', () => {
    expect(parseSqlUtc('2026-01-02 03:04:05')?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('parses ISO strings that already carry Z', () => {
    expect(parseSqlUtc('2026-01-02T03:04:05Z')?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseSqlUtc('not a date')).toBeNull();
  });
});
