import type { OsintKillmail } from './zkill.js';

export type TemporalProfile = {
  hourly_histogram: Record<number, number>;
  daily_histogram: Record<number, number>;
  peak_hours: number[];
  sleep_window: { start_hour: number; end_hour: number; duration_hours: number };
  estimated_timezone: { name: string; utc_offset: number; confidence: number };
  activity_regularity: number;
  active_days_per_week: number;
  sample_size: number;
};

export type SessionProfile = {
  sessions_count: number;
  avg_session_minutes: number;
  median_session_minutes: number;
  longest_session_minutes: number;
  sessions_per_week: number;
  total_play_hours: number;
  sessions: Array<{
    start: string;
    end: string;
    duration_minutes: number;
    kill_count: number;
    systems: string[];
  }>;
};

const SESSION_GAP_MINUTES = 90;

const EMPTY_TEMPORAL: TemporalProfile = {
  hourly_histogram: {},
  daily_histogram: {},
  peak_hours: [],
  sleep_window: { start_hour: 0, end_hour: 0, duration_hours: 0 },
  estimated_timezone: { name: 'Unknown', utc_offset: 0, confidence: 0 },
  activity_regularity: 0,
  active_days_per_week: 0,
  sample_size: 0,
};

const EMPTY_SESSION: SessionProfile = {
  sessions_count: 0,
  avg_session_minutes: 0,
  median_session_minutes: 0,
  longest_session_minutes: 0,
  sessions_per_week: 0,
  total_play_hours: 0,
  sessions: [],
};

function parseKillTimes(kills: OsintKillmail[]): Date[] {
  const dates: Date[] = [];
  for (const k of kills) {
    if (!k.killmail_time) continue;
    const d = new Date(k.killmail_time);
    if (!Number.isNaN(d.getTime())) dates.push(d);
  }
  return dates;
}

function buildHourlyHistogram(dates: Date[]): Record<number, number> {
  const hist: Record<number, number> = {};
  for (let h = 0; h < 24; h++) hist[h] = 0;
  for (const d of dates) hist[d.getUTCHours()] += 1;
  return hist;
}

function buildDailyHistogram(dates: Date[]): Record<number, number> {
  const hist: Record<number, number> = {};
  for (let d = 0; d < 7; d++) hist[d] = 0;
  for (const dt of dates) hist[dt.getUTCDay()] += 1;
  return hist;
}

function findPeakHours(hist: Record<number, number>): number[] {
  return Object.entries(hist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .filter(([, count]) => count > 0)
    .map(([hour]) => Number(hour));
}

function findSleepWindow(hist: Record<number, number>): {
  start_hour: number;
  end_hour: number;
  duration_hours: number;
} {
  let bestStart = 0;
  let bestLen = 0;

  for (let start = 0; start < 24; start++) {
    let len = 0;
    for (let offset = 0; offset < 24; offset++) {
      const hour = (start + offset) % 24;
      if (hist[hour] <= 1) {
        len += 1;
      } else {
        break;
      }
    }
    if (len > bestLen) {
      bestLen = len;
      bestStart = start;
    }
  }

  return {
    start_hour: bestStart,
    end_hour: (bestStart + bestLen) % 24,
    duration_hours: bestLen,
  };
}

function estimateTimezone(sleepWindow: {
  start_hour: number;
  duration_hours: number;
}): { name: string; utc_offset: number } {
  const midpoint = (sleepWindow.start_hour + sleepWindow.duration_hours / 2) % 24;
  let offset = (midpoint - 3.5 + 24) % 24;
  if (offset > 12) offset -= 24;
  offset = Math.round(offset);

  // Narrower ranges first — otherwise EU (0–3) shadows RU (3–5) and AU (8–11)
  // shadows CN/KR (8–9), making those labels unreachable.
  let name: string;
  if (offset >= -5 && offset <= -4) name = 'US East';
  else if (offset >= -8 && offset <= -7) name = 'US West';
  else if (offset >= 8 && offset <= 9) name = 'CN/KR';
  else if (offset >= 4 && offset <= 5) name = 'RU';
  else if (offset >= 0 && offset <= 3) name = 'EU';
  else if (offset >= 10 && offset <= 11) name = 'AU';
  else name = `UTC${offset >= 0 ? '+' : ''}${offset}`;

  return { name, utc_offset: offset };
}

function computeConfidence(sampleSize: number): number {
  if (sampleSize < 10) return 0.3;
  if (sampleSize < 30) return 0.55;
  if (sampleSize < 60) return 0.75;
  return 0.9;
}

function computeActivityRegularity(dates: Date[]): number {
  if (dates.length < 2) return 0;

  const dayCounts = new Map<string, number>();
  for (const d of dates) {
    const key = d.toISOString().slice(0, 10);
    dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
  }

  const counts = [...dayCounts.values()];
  const mean = counts.reduce((s, c) => s + c, 0) / counts.length;
  if (mean === 0) return 0;

  const variance = counts.reduce((s, c) => s + (c - mean) ** 2, 0) / counts.length;
  const cv = Math.sqrt(variance) / mean;

  return Math.max(0, Math.min(1, 1 - cv));
}

function computeActiveDaysPerWeek(dates: Date[]): number {
  if (dates.length === 0) return 0;

  const uniqueDays = new Set(dates.map((d) => d.toISOString().slice(0, 10)));
  const sorted = [...uniqueDays].sort();
  const firstDay = new Date(sorted[0]!);
  const lastDay = new Date(sorted[sorted.length - 1]!);
  const windowDays = Math.max(1, (lastDay.getTime() - firstDay.getTime()) / (1000 * 60 * 60 * 24) + 1);
  const weeks = windowDays / 7;

  return weeks < 1 ? uniqueDays.size : uniqueDays.size / weeks;
}

export function analyzeTemporalProfile(kills: OsintKillmail[]): TemporalProfile {
  const dates = parseKillTimes(kills);
  if (dates.length === 0) return EMPTY_TEMPORAL;

  const hourly_histogram = buildHourlyHistogram(dates);
  const daily_histogram = buildDailyHistogram(dates);
  const peak_hours = findPeakHours(hourly_histogram);
  const sleep_window = findSleepWindow(hourly_histogram);
  const tz = estimateTimezone(sleep_window);
  const confidence = computeConfidence(dates.length);

  return {
    hourly_histogram,
    daily_histogram,
    peak_hours,
    sleep_window,
    estimated_timezone: { ...tz, confidence },
    activity_regularity: computeActivityRegularity(dates),
    active_days_per_week: computeActiveDaysPerWeek(dates),
    sample_size: dates.length,
  };
}

export function reconstructSessions(kills: OsintKillmail[]): SessionProfile {
  const timed = kills
    .filter((k): k is OsintKillmail & { killmail_time: string } => {
      if (!k.killmail_time) return false;
      return !Number.isNaN(new Date(k.killmail_time).getTime());
    })
    .sort((a, b) => new Date(a.killmail_time).getTime() - new Date(b.killmail_time).getTime());

  if (timed.length === 0) return EMPTY_SESSION;

  const sessions: SessionProfile['sessions'] = [];
  let currentSession: { kills: typeof timed } = { kills: [timed[0]!] };

  for (let i = 1; i < timed.length; i++) {
    const prev = new Date(timed[i - 1]!.killmail_time).getTime();
    const curr = new Date(timed[i]!.killmail_time).getTime();
    const gapMinutes = (curr - prev) / (1000 * 60);

    if (gapMinutes > SESSION_GAP_MINUTES) {
      sessions.push(buildSession(currentSession.kills));
      currentSession = { kills: [timed[i]!] };
    } else {
      currentSession.kills.push(timed[i]!);
    }
  }
  sessions.push(buildSession(currentSession.kills));

  const durations = sessions.map((s) => s.duration_minutes).sort((a, b) => a - b);
  const totalMinutes = durations.reduce((s, d) => s + d, 0);

  const firstTime = new Date(timed[0]!.killmail_time).getTime();
  const lastTime = new Date(timed[timed.length - 1]!.killmail_time).getTime();
  const windowDays = Math.max(1, (lastTime - firstTime) / (1000 * 60 * 60 * 24));
  const windowWeeks = Math.max(1, windowDays / 7);

  const medianIdx = Math.floor(durations.length / 2);
  const median = durations.length % 2 === 1
    ? durations[medianIdx]!
    : (durations[medianIdx - 1]! + durations[medianIdx]!) / 2;

  return {
    sessions_count: sessions.length,
    avg_session_minutes: Math.round(totalMinutes / sessions.length),
    median_session_minutes: Math.round(median),
    longest_session_minutes: Math.max(...durations),
    sessions_per_week: Math.round((sessions.length / windowWeeks) * 10) / 10,
    total_play_hours: Math.round((totalMinutes / 60) * 10) / 10,
    sessions,
  };
}

function buildSession(
  kills: Array<OsintKillmail & { killmail_time: string }>,
): SessionProfile['sessions'][number] {
  const start = kills[0]!.killmail_time;
  const end = kills[kills.length - 1]!.killmail_time;
  const durationMs = new Date(end).getTime() - new Date(start).getTime();

  const systems = [
    ...new Set(
      kills
        .filter((k) => k.solar_system_id != null)
        .map((k) => `system:${k.solar_system_id}`),
    ),
  ];

  return {
    start,
    end,
    duration_minutes: Math.round(durationMs / (1000 * 60)),
    kill_count: kills.length,
    systems,
  };
}
