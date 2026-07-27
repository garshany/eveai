import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { MarketRegionComparisonRow } from '../../types';
import { formatIsk, formatQuantity } from './format';

type SortKey = 'region' | 'min_sell' | 'max_buy' | 'spread' | 'sell_volume' | 'buy_volume';
type SortDir = 'asc' | 'desc';

type Props = {
  typeId: number;
  selectedRegionId: number | null;
};

/**
 * Сравнение регионов по товару: лучшие sell/buy, спред и объёмы. Сортировка
 * кликом по заголовку (asc/desc, NULL всегда внизу); лучшие min sell / max buy
 * подсвечены, строка выбранного в тулбаре региона выделена.
 */
export function RegionCompareTable({ typeId, selectedRegionId }: Props) {
  const { locale, t } = useI18n();
  const [rows, setRows] = useState<MarketRegionComparisonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('min_sell');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const payload = await webApi.market.regionComparison(typeId);
      if (current !== generation.current) return;
      setRows(payload.regions);
    } catch (reason) {
      if (current !== generation.current) return;
      setRows([]);
      setError(reason instanceof Error ? reason.message : t('requestFailed'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [typeId, t]);

  useEffect(() => { void load(); }, [load]);

  const bestSell = useMemo(() => {
    const values = rows.map((row) => row.min_sell).filter((value): value is number => value !== null);
    return values.length > 0 ? Math.min(...values) : null;
  }, [rows]);
  const bestBuy = useMemo(() => {
    const values = rows.map((row) => row.max_buy).filter((value): value is number => value !== null);
    return values.length > 0 ? Math.max(...values) : null;
  }, [rows]);

  const sorted = useMemo(() => {
    const direction = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const aValue = sortValue(a, sortKey);
      const bValue = sortValue(b, sortKey);
      if (aValue === null && bValue === null) return 0;
      if (aValue === null) return 1; // NULL всегда внизу, независимо от направления
      if (bValue === null) return -1;
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return aValue.localeCompare(bValue, locale === 'ru' ? 'ru' : 'en') * direction;
      }
      return ((aValue as number) - (bValue as number)) * direction;
    });
  }, [rows, sortKey, sortDir, locale]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'region' ? 'asc' : 'desc');
      // Цены интуитивнее от лучшей: min sell по возрастанию, max buy по убыванию.
      if (key === 'min_sell') setSortDir('asc');
    }
  };

  const renderHeader = (key: SortKey, label: string, numeric: boolean) => (
    <th aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={`region-compare__sort${numeric ? ' region-compare__sort--num' : ''}`}
        onClick={() => toggleSort(key)}
      >
        {label}
        {sortKey === key ? <span className="region-compare__sort-mark" aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span> : null}
      </button>
    </th>
  );

  return (
    <section className="region-compare" aria-label={t('marketCompareTitle')}>
      <h3 className="region-compare__title">{t('marketCompareTitle')}</h3>
      {loading ? <div className="panel-loading">{t('loading')}…</div> : null}
      {error ? (
        <div className="workspace-error" role="alert">
          {error}
          <button type="button" onClick={() => void load()}>{t('retry')}</button>
        </div>
      ) : null}
      {!loading && !error && sorted.length === 0 ? (
        <p className="region-compare__empty">{t('marketCompareEmpty')}</p>
      ) : null}
      {!loading && !error && sorted.length > 0 ? (
        <div className="region-compare__scroll">
          <table className="region-compare__table">
            <thead>
              <tr>
                {renderHeader('region', t('marketRegion'), false)}
                {renderHeader('min_sell', t('marketBestSell'), true)}
                {renderHeader('max_buy', t('marketBestBuy'), true)}
                {renderHeader('spread', t('marketSpread'), true)}
                {renderHeader('sell_volume', t('marketSellVolume'), true)}
                {renderHeader('buy_volume', t('marketBuyVolume'), true)}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const spread = row.min_sell !== null && row.max_buy !== null ? row.min_sell - row.max_buy : null;
                return (
                  <tr
                    key={row.region_id}
                    className={row.region_id === selectedRegionId ? 'region-compare__row--selected' : undefined}
                  >
                    <td className="region-compare__cell region-compare__cell--region">{row.region_name ?? `#${row.region_id}`}</td>
                    <td className={`region-compare__cell region-compare__cell--num${row.min_sell !== null && row.min_sell === bestSell ? ' region-compare__cell--best' : ''}`}>
                      {formatIsk(row.min_sell, locale)}
                    </td>
                    <td className={`region-compare__cell region-compare__cell--num${row.max_buy !== null && row.max_buy === bestBuy ? ' region-compare__cell--best' : ''}`}>
                      {formatIsk(row.max_buy, locale)}
                    </td>
                    <td className="region-compare__cell region-compare__cell--num">{formatIsk(spread, locale)}</td>
                    <td className="region-compare__cell region-compare__cell--num">{formatQuantity(row.sell_volume, locale)}</td>
                    <td className="region-compare__cell region-compare__cell--num">{formatQuantity(row.buy_volume, locale)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function sortValue(row: MarketRegionComparisonRow, key: SortKey): string | number | null {
  switch (key) {
    case 'region': return row.region_name ?? null;
    case 'min_sell': return row.min_sell;
    case 'max_buy': return row.max_buy;
    case 'spread': return row.min_sell !== null && row.max_buy !== null ? row.min_sell - row.max_buy : null;
    case 'sell_volume': return row.sell_volume;
    case 'buy_volume': return row.buy_volume;
  }
}
