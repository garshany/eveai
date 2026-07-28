/**
 * SQLite's datetime('now') is UTC rendered as «YYYY-MM-DD HH:MM:SS» with no
 * zone marker; Date.parse would read that as LOCAL time and shift every
 * duration by the viewer's UTC offset (a Moscow user watched the "agent is
 * composing" timer start at 180:00). Every SQL timestamp crossing into the
 * browser goes through here.
 */
export function parseSqlUtcDate(value: string): Date {
  const normalized = value.includes('T') || value.endsWith('Z')
    ? value
    : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized);
}

export function parseSqlUtcMs(value: string): number {
  return parseSqlUtcDate(value).getTime();
}
