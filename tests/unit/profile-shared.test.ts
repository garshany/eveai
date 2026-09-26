import { describe, expect, it } from 'vitest';
import { needsAutoSync, parseSqlUtc } from '../../web/src/components/profile/shared';
import type { ProfileFreshness } from '../../web/src/types';

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

describe('needsAutoSync', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const entry = (overrides: Partial<ProfileFreshness>): ProfileFreshness => ({
    dataset: 'wallet',
    status: 'ok',
    syncedAt: '2026-09-26 11:00:00',
    expiresAt: '2026-09-26 11:05:00',
    error: null,
    ...overrides,
  });

  it('syncs an expired or never-synced dataset once the tab opens', () => {
    expect(needsAutoSync(entry({}), now)).toBe(true);
    expect(needsAutoSync([entry({ expiresAt: '2026-09-26 13:00:00' }), entry({ syncedAt: null, status: 'pending' })], now)).toBe(true);
  });

  it('leaves fresh data, missing scopes and backed-off errors alone', () => {
    expect(needsAutoSync(entry({ expiresAt: '2026-09-26 13:00:00' }), now)).toBe(false);
    expect(needsAutoSync(entry({ status: 'no_scope', syncedAt: null }), now)).toBe(false);
    expect(needsAutoSync(entry({ status: 'error' }), now)).toBe(false);
    expect(needsAutoSync(null, now)).toBe(false);
  });
});
