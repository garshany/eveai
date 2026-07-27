import { useI18n } from '../../i18n';
import type { MarketOverview as MarketOverviewData, MarketSnapshotMeta } from '../../types';
import { formatClockTime, formatIsk, formatPercent, formatQuantity } from './format';

type Props = {
  overview: MarketOverviewData;
  snapshot: MarketSnapshotMeta | null;
  lastUpdatedAt: Date | null;
};

/** Карточки сводки по товару + бейдж свежести локального снапшота. */
export function MarketOverview({ overview, snapshot, lastUpdatedAt }: Props) {
  const { locale, t } = useI18n();
  const isk = (value: number | null) => (value === null ? '—' : `${formatIsk(value, locale)} ISK`);

  const snapshotLoaded = Boolean(snapshot?.loaded);
  const stale = !snapshot || !snapshotLoaded || snapshot.stale;
  const age = snapshot?.age_minutes ?? null;
  const freshnessText = !snapshotLoaded
    ? t('marketSnapshotNotLoaded')
    : age === null
      ? t('marketDataUnknown')
      : age === 0
        ? t('marketDataJustNow')
        : t('marketDataAge').replace('{age}', String(age));

  return (
    <section className="market-overview">
      <div className="market-overview__meta">
        <span
          className={`market-freshness${stale ? ' market-freshness--stale' : ''}`}
          title={stale ? t('marketSnapshotStale') : undefined}
        >
          {freshnessText}
        </span>
        {lastUpdatedAt ? (
          <span className="market-overview__updated">
            {t('marketUpdatedAt').replace('{time}', formatClockTime(lastUpdatedAt, locale))}
          </span>
        ) : null}
      </div>
      <div className="market-stats">
        <StatCard label={t('marketBestSell')} value={isk(overview.best_sell)} tone="sell" />
        <StatCard label={t('marketBestBuy')} value={isk(overview.best_buy)} tone="buy" />
        <StatCard label={t('marketSpread')} value={isk(overview.spread_abs)} sub={formatPercent(overview.spread_pct, locale)} />
        <StatCard
          label={t('marketSellVolume')}
          value={formatQuantity(overview.sell_volume, locale)}
          sub={`${formatQuantity(overview.sell_orders, locale)} ${t('marketOrdersCount')}`}
        />
        <StatCard
          label={t('marketBuyVolume')}
          value={formatQuantity(overview.buy_volume, locale)}
          sub={`${formatQuantity(overview.buy_orders, locale)} ${t('marketOrdersCount')}`}
        />
      </div>
    </section>
  );
}

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'sell' | 'buy' }) {
  return (
    <article className="market-stat">
      <span className="market-stat__label">{label}</span>
      <strong className={`market-stat__value${tone ? ` market-stat__value--${tone}` : ''}`}>{value}</strong>
      {sub ? <small className="market-stat__sub">{sub}</small> : null}
    </article>
  );
}
