/**
 * Locale-aware date formatting for the support/transparency screen.
 * One helper set on purpose: every date the page renders goes through here,
 * so raw ISO strings never leak into the UI.
 *
 * Day and month keys arrive as UTC buckets (YYYY-MM-DD / YYYY-MM); pinning
 * them to UTC avoids an off-by-one shift for users east of Greenwich.
 * Timestamps (ISO with time) render in the viewer's local timezone.
 */
import { parseSqlUtcDate } from './sql-utc';

export type DateLocale = 'ru' | 'en';

function intlLocale(locale: DateLocale): string {
  return locale === 'ru' ? 'ru-RU' : 'en-US';
}

function parseUtcDayKey(value: string): Date {
  return new Date(value.includes('T') ? value : `${value}T00:00:00Z`);
}

/** Day bucket label: "27 июл" / "Jul 27". */
export function formatDay(value: string, locale: DateLocale): string {
  const date = parseUtcDayKey(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(intlLocale(locale), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
}

/**
 * Timestamp for the session list: today collapses to «11:07», yesterday to a
 * word, anything older to «26.07». The value arrives as a SQLite UTC string
 * without a zone marker, so it goes through parseSqlUtcDate — Date.parse would
 * read it as local time and shift every row by the viewer's offset.
 */
export function formatRelativeDay(value: string, locale: DateLocale): string {
  const date = parseSqlUtcDate(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const days = calendarDaysBetween(date, now);
  if (days === 0) {
    return new Intl.DateTimeFormat(intlLocale(locale), { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  if (days === 1) return locale === 'ru' ? 'вчера' : 'yesterday';
  return new Intl.DateTimeFormat(intlLocale(locale), { day: '2-digit', month: '2-digit' }).format(date);
}

/** Whole calendar days between two instants in the viewer's own timezone. */
function calendarDaysBetween(from: Date, to: Date): number {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);
}

/** Month bucket label: "июль 2026" / "July 2026". */
export function formatMonth(value: string, locale: DateLocale): string {
  const date = new Date(`${value}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(intlLocale(locale), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** Date + time without seconds, for "generated at" captions. */
export function formatDateTime(value: string, locale: DateLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * Date only, for day-precision values like the FX rate date. Pinned to UTC
 * like the other day-key helpers: a bare YYYY-MM-DD parses as midnight UTC,
 * and local-zone formatting would shift it a day west of Greenwich.
 */
export function formatDate(value: string, locale: DateLocale): string {
  const date = parseUtcDayKey(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}
