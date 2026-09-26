import { describe, expect, it } from 'vitest';
import { analyzeTemporalProfile, estimateTimezone } from '../../src/eve-osint/temporal.js';
import type { OsintKillmail } from '../../src/eve-osint/types.js';

function killAt(iso: string, id: number): OsintKillmail {
  return { roles: { attacker: true, victim: false }, killmail_id: id, killmail_time: iso, attacker_count: 1, attackers: [] };
}

describe('analyzeTemporalProfile sleep window', () => {
  it('does not report a 24-hour sleep window for a sparse sample (one kill per hour)', () => {
    // Twelve kills, one in each hour 12..23 UTC: every hour has <= 1 kill.
    const kills = Array.from({ length: 12 }, (_, index) =>
      killAt(`2026-07-${String(10 + index).padStart(2, '0')}T${String(12 + index).padStart(2, '0')}:30:00Z`, index + 1));

    const profile = analyzeTemporalProfile(kills);

    expect(profile.sleep_window.duration_hours).toBeLessThan(24);
    // Quiet hours are 00..11 UTC, not a whole-day window centred on noon.
    expect(profile.sleep_window).toMatchObject({ start_hour: 0, end_hour: 12, duration_hours: 12 });
    expect(profile.estimated_timezone.name).not.toBe('CN/KR');
  });

  it('keeps the tolerant (<= 1 kill) window for dense samples', () => {
    const kills: OsintKillmail[] = [];
    let id = 1;
    for (let day = 1; day <= 5; day += 1) {
      for (let hour = 16; hour <= 23; hour += 1) {
        kills.push(killAt(`2026-07-0${day}T${String(hour).padStart(2, '0')}:00:00Z`, id++));
      }
    }
    kills.push(killAt('2026-07-06T03:00:00Z', id++)); // one stray kill inside the quiet hours

    const profile = analyzeTemporalProfile(kills);

    expect(profile.sleep_window).toMatchObject({ start_hour: 0, end_hour: 16, duration_hours: 16 });
  });
});

describe('estimateTimezone offset direction', () => {
  // A player sleeps centred on ~03:30 local time; the sleep midpoint is
  // observed in UTC. offset = 3.5 - midpoint, NOT midpoint - 3.5. With the
  // sign inverted every label became its mirror image (RU ⇄ US East, etc.).
  // Each row: local sleep centred at 03:30, so midpoint_utc = 3.5 - offset.
  it.each([
    // [label, start_hour, duration_hours(=7), expected offset, expected name]
    ['EU (UTC+1)', 23, 7, 1, 'EU'],
    ['RU (UTC+4)', 20, 7, 4, 'RU'],
    ['CN/KR (UTC+8)', 16, 7, 8, 'CN/KR'],
    ['AU (UTC+10)', 14, 7, 10, 'AU'],
    ['US East (UTC-5)', 5, 7, -5, 'US East'],
    ['US West (UTC-8)', 8, 7, -8, 'US West'],
  ])('maps a %s sleep window to the eastern-positive offset', (_label, start, duration, offset, name) => {
    const tz = estimateTimezone({ start_hour: start, duration_hours: duration });
    expect(tz.utc_offset).toBe(offset);
    expect(tz.name).toBe(name);
  });
});
