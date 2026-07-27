import { useCallback, useEffect, useRef, useState } from 'react';
import { webApi } from '../../api';
import { useI18n, type Locale } from '../../i18n';
import type { ProfileDatasetId, ProfileFreshness } from '../../types';

const localeTag = (locale: Locale) => (locale === 'ru' ? 'ru-RU' : 'en-US');

/**
 * Таймстемпы API — SQL UTC строки 'YYYY-MM-DD HH:MM:SS' или ISO с зоной
 * ('2026-07-20T10:00:00Z' из ESI); Z дописывается только если зоны нет.
 */
export function parseSqlUtc(value: string): Date | null {
  const isoish = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(isoish) ? isoish : `${isoish}Z`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/** «данные на HH:MM» — локальное время; старше суток — с датой. */
export function formatLocalTime(value: string | null, locale: Locale): string | null {
  if (!value) return null;
  const date = parseSqlUtc(value);
  if (!date) return null;
  const olderThanDay = Date.now() - date.getTime() > 24 * 3_600_000;
  return new Intl.DateTimeFormat(localeTag(locale), olderThanDay
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }).format(date);
}

/** Дата + время в локальной таймзоне (issued, finishDate). */
export function formatLocalDateTime(value: string | null, locale: Locale): string | null {
  if (!value) return null;
  const date = parseSqlUtc(value);
  if (!date) return null;
  return new Intl.DateTimeFormat(localeTag(locale), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

/** Уровни навыков в игре принято писать римскими (I–V). */
export function romanLevel(level: number): string {
  return ROMAN[level - 1] ?? String(level);
}

/**
 * Ленивый загрузчик данных вкладки: грузит при монтировании (вкладка монтируется
 * при первом открытии), reload перечитывает после ручного синка.
 */
export function useProfileData<T>(loader: () => Promise<T>) {
  const { t } = useI18n();
  // t меняет идентичность при смене локали; reload от неё зависеть не должен,
  // иначе смена языка перезапускает загрузку всех вкладок.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const payload = await loader();
      if (current !== generation.current) return;
      setData(payload);
    } catch (reason) {
      if (current !== generation.current) return;
      setError(reason instanceof Error ? reason.message : tRef.current('requestFailed'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [loader]);

  useEffect(() => { void reload(); }, [reload]);

  return { data, loading, error, reload };
}

/**
 * Ручной синк датасетов вкладки: POST /api/web/profile/sync (CSRF), спиннер
 * на время запроса, затем перезагрузка данных вкладки.
 */
export function useProfileSync(csrfToken: string, datasets: ProfileDatasetId[] | undefined, reload: () => Promise<void>) {
  const [syncing, setSyncing] = useState(false);
  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      await webApi.profile.sync(datasets, csrfToken);
    } catch {
      // Ошибку синка покажет freshness после перезагрузки; сам запрос не роняем.
    } finally {
      await reload().catch(() => undefined);
      setSyncing(false);
    }
  }, [csrfToken, datasets, reload]);
  return { syncing, sync };
}

/**
 * Отметка свежести + кнопка «Обновить». Несколько freshness (wallet/skills)
 * сводятся в худший статус и самое свежее время синка.
 */
export function FreshnessBar({ freshness, syncing, onSync }: {
  freshness: ProfileFreshness | ProfileFreshness[] | null;
  syncing: boolean;
  onSync: () => void;
}) {
  const { locale, t } = useI18n();
  const entries = freshness === null ? [] : Array.isArray(freshness) ? freshness : [freshness];
  let note: string | null = null;
  if (entries.some((entry) => entry.status === 'no_scope')) {
    note = t('profileSyncNoScope');
  } else if (entries.some((entry) => entry.status === 'error')) {
    const detail = entries.find((entry) => entry.status === 'error')?.error;
    note = detail ? `${t('profileSyncError')} ${detail}` : t('profileSyncError');
  } else if (entries.some((entry) => entry.status === 'pending')) {
    note = t('profileSyncPending');
  } else {
    const syncedAt = entries
      .map((entry) => entry.syncedAt)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;
    const time = formatLocalTime(syncedAt, locale);
    note = time ? t('profileDataAt').replace('{time}', time) : null;
    // Признак «протухло»: окно свежести (ESI Expires) уже вышло.
    const stale = entries.some((entry) => {
      const expires = entry.expiresAt ? parseSqlUtc(entry.expiresAt) : null;
      return expires !== null && expires.getTime() < Date.now();
    });
    if (note && stale) note = `${note} · ${t('profileDataStale')}`;
  }
  return (
    <div className="profile-freshness">
      {note ? <span className="profile-freshness__note">{note}</span> : null}
      <button className="button profile-freshness__button" type="button" disabled={syncing} onClick={onSync}>
        {syncing ? <span className="button-spinner" aria-hidden="true" /> : null}
        {syncing ? t('profileSyncing') : t('refresh')}
      </button>
    </div>
  );
}
