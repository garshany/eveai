import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { ProfileAssetItem, ProfileAssetLocation, ProfilePriceBook } from '../../types';
import { formatIsk, formatQuantity } from '../market/format';
import { FreshnessBar, useProfileData, useProfileSync } from './shared';

// Совпадает с дефолтным limit на сервере (src/web/profile-routes.ts).
const PAGE_SIZE = 50;

type Props = { csrfToken: string };

/**
 * Схрон пилота: локации по убыванию оценки. Клик по локации раскрывает
 * таблицу предметов (своя пагинация). «Показать ещё» догружает по offset.
 */
export function AssetsPanel({ csrfToken }: Props) {
  const { t } = useI18n();
  const [locations, setLocations] = useState<ProfileAssetLocation[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const loader = useCallback(async () => {
    const payload = await webApi.profile.assets(0, PAGE_SIZE);
    setLocations(payload.locations);
    setTotal(payload.total);
    return payload;
  }, []);
  const { data, loading, error, reload } = useProfileData(loader);
  const { syncing, sync } = useProfileSync(csrfToken, ['assets'], reload);

  const showMore = async () => {
    setLoadingMore(true);
    try {
      const payload = await webApi.profile.assets(locations.length, PAGE_SIZE);
      setLocations((prev) => [...prev, ...payload.locations]);
      setTotal(payload.total);
    } catch {
      // Данные остаются как есть — пользователь может нажать «Показать ещё» снова.
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading && !data) return <div className="panel-loading">{t('loading')}…</div>;
  if (error) return <div className="workspace-error" role="alert">{error}<button type="button" onClick={() => void reload()}>{t('retry')}</button></div>;
  if (!data) return null;

  return (
    <section className="profile-panel">
      <FreshnessBar freshness={data.freshness} syncing={syncing} onSync={() => void sync()} />
      <p className="profile-panel__meta">
        {`${t('profileValuationMethod')} · ${priceBookNote(data.priceBook, t)}`}
      </p>
      {locations.length === 0 ? <p className="profile-panel__empty">{t('profileAssetsEmpty')}</p> : null}
      <div className="asset-locations">
        {locations.map((location) => (
          <LocationRow
            key={location.locationId}
            location={location}
            expanded={expanded === location.locationId}
            onToggle={() => setExpanded((current) => (current === location.locationId ? null : location.locationId))}
          />
        ))}
      </div>
      {locations.length < total ? (
        <button className="button profile-panel__more" type="button" disabled={loadingMore} onClick={() => void showMore()}>
          {t('marketShowMore')}
        </button>
      ) : null}
    </section>
  );
}

function priceBookNote(book: ProfilePriceBook, t: ReturnType<typeof useI18n>['t']): string {
  if (!book.loaded) return t('marketSnapshotNotLoaded');
  const age = book.ageMinutes === null
    ? t('marketDataUnknown')
    : book.ageMinutes <= 0
      ? t('marketDataJustNow')
      : t('marketDataAge').replace('{age}', String(book.ageMinutes));
  return book.stale ? `${age} · ${t('marketSnapshotStale')}` : age;
}

function LocationRow({ location, expanded, onToggle }: {
  location: ProfileAssetLocation;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { locale, t } = useI18n();
  // Сервер отдаёт kind, подпись локализует клиент: структура без имени,
  // имущество в космосе — «В космосе: <система>», остальное — честный
  // «Неизвестная локация».
  const name = location.kind === 'structure'
    ? t('profileStructure')
    : location.name
      ?? (location.solarSystemName
        ? t('profileInSpace').replace('{system}', location.solarSystemName)
        : t('profileUnknownLocation'));
  const place = [location.name ? location.solarSystemName : null, location.regionName]
    .filter(Boolean)
    .join(' — ');
  return (
    <article className={`asset-location${expanded ? ' asset-location--open' : ''}`}>
      <button className="asset-location__head" type="button" onClick={onToggle} aria-expanded={expanded}>
        <span className="asset-location__name">
          {name}
          {place ? <small>{place}</small> : null}
        </span>
        <span className="asset-location__stat">{formatQuantity(location.itemCount, locale)}</span>
        <span className="asset-location__stat">{`${formatQuantity(Math.round(location.totalVolume), locale)} м³`}</span>
        <span className="asset-location__value">
          {location.estimatedValue === null ? '—' : `${formatIsk(location.estimatedValue, locale)} ISK`}
          {location.valuation === 'partial' ? <small className="asset-location__flag">{t('profileValuationPartial')}</small> : null}
          {location.valuation === 'unavailable' ? <small className="asset-location__flag">{t('profileValuationUnavailable')}</small> : null}
        </span>
      </button>
      {expanded ? <LocationItems locationId={location.locationId} /> : null}
    </article>
  );
}

function LocationItems({ locationId }: { locationId: number }) {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<ProfileAssetItem[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<'loading' | 'error' | 'ok'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (offset: number, append: boolean) => {
    if (append) setLoadingMore(true);
    try {
      const payload = await webApi.profile.assetItems(locationId, offset, PAGE_SIZE);
      setItems((prev) => (append ? [...prev, ...payload.items] : payload.items));
      setTotal(payload.total);
      setState('ok');
    } catch {
      // Ошибка первичной загрузки — экран ошибки; ошибка догрузки оставляет список как есть.
      if (!append) setState('error');
    } finally {
      setLoadingMore(false);
    }
  }, [locationId]);

  // Первичная загрузка при раскрытии локации.
  useEffect(() => { void load(0, false); }, [load]);

  if (state === 'loading') return <div className="panel-loading">{t('loading')}…</div>;
  if (state === 'error') {
    return (
      <div className="workspace-error" role="alert">
        {t('requestFailed')}
        <button type="button" onClick={() => void load(0, false)}>{t('retry')}</button>
      </div>
    );
  }
  if (items.length === 0) return <p className="profile-panel__empty">{t('profileItemsEmpty')}</p>;

  return (
    <div className="profile-table asset-items">
      <table>
        <thead>
          <tr>
            <th>{t('profileItem')}</th>
            <th>{t('profileGroup')}</th>
            <th className="num">{t('marketQuantity')}</th>
            <th className="num">{t('profileVolume')}</th>
            <th className="num">{t('profileUnitPrice')}</th>
            <th className="num">{t('profileTotalValue')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.itemId}>
              <td>
                {item.typeName ?? `#${item.typeId}`}
                {item.isBlueprintCopy ? <small className="asset-location__flag"> {t('profileBpc')}</small> : null}
              </td>
              <td>{item.groupName ?? '—'}</td>
              <td className="num">{formatQuantity(item.quantity, locale)}</td>
              <td className="num">{item.totalVolume === null ? '—' : `${formatQuantity(Math.round(item.totalVolume), locale)} м³`}</td>
              <td className="num">{item.unitPrice === null ? '—' : formatIsk(item.unitPrice, locale)}</td>
              <td className="num">{item.totalValue === null ? '—' : formatIsk(item.totalValue, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length < total ? (
        <button className="button profile-panel__more" type="button" disabled={loadingMore} onClick={() => void load(items.length, true)}>
          {t('marketShowMore')}
        </button>
      ) : null}
    </div>
  );
}
