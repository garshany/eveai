import type { Locale } from '../../i18n';

const localeTag = (locale: Locale) => (locale === 'ru' ? 'ru-RU' : 'en-US');

/**
 * Цены ISK: точные с копейками до миллиона, дальше compact (1,23 млрд).
 * compact=false принудительно отключает сокращение (ордер-бук показывает
 * точную цену, как в игровом окне маркета).
 */
export function formatIsk(value: number | null, locale: Locale, options: { compact?: boolean } = {}): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const compact = options.compact ?? Math.abs(value) >= 1_000_000;
  return new Intl.NumberFormat(localeTag(locale), {
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatQuantity(value: number | null, locale: Locale): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const compact = Math.abs(value) >= 10_000_000;
  return new Intl.NumberFormat(localeTag(locale), {
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 0,
  }).format(value);
}

export function formatPercent(value: number | null, locale: Locale): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 }).format(value)}%`;
}

export function formatClockTime(value: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}

/** Значение dogma-атрибута с единицей измерения: целые без дробной части. */
export function formatAttributeValue(value: number, unit: string | null, locale: Locale): string {
  const formatted = new Intl.NumberFormat(localeTag(locale), {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}
