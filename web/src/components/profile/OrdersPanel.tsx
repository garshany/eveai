import { useCallback, useState } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { ProfileOrder } from '../../types';
import { formatIsk, formatQuantity } from '../market/format';
import { FreshnessBar, formatLocalDateTime, useProfileData, useProfileSync } from './shared';

const PAGE_SIZE = 50;

type Props = { csrfToken: string };

/** Активные ордера пилота: сводка по сторонам и эскроу + таблица с пагинацией. */
export function OrdersPanel({ csrfToken }: Props) {
  const { locale, t } = useI18n();
  const [orders, setOrders] = useState<ProfileOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const loader = useCallback(async () => {
    const payload = await webApi.profile.orders(0, PAGE_SIZE);
    setOrders(payload.orders);
    setTotal(payload.total);
    return payload;
  }, []);
  const { data, loading, error, reload } = useProfileData(loader);
  const { syncing, sync } = useProfileSync(csrfToken, ['orders'], reload);

  const showMore = async () => {
    setLoadingMore(true);
    try {
      const payload = await webApi.profile.orders(orders.length, PAGE_SIZE);
      setOrders((prev) => [...prev, ...payload.orders]);
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

  const { totals } = data;
  return (
    <section className="profile-panel">
      <FreshnessBar freshness={data.freshness} syncing={syncing} onSync={() => void sync()} />
      <div className="order-totals">
        <article className="chart-stat">
          <span className="chart-stat__label">{t('marketSellSide')}</span>
          <strong className="chart-stat__value">
            {t('profileSellSummary')
              .replace('{count}', formatQuantity(totals.sellCount, locale))
              .replace('{value}', formatIsk(totals.sellTotal, locale))}
          </strong>
        </article>
        <article className="chart-stat">
          <span className="chart-stat__label">{t('marketBuySide')}</span>
          <strong className="chart-stat__value">
            {t('profileBuySummary')
              .replace('{count}', formatQuantity(totals.buyCount, locale))
              .replace('{value}', formatIsk(totals.buyTotal, locale))}
          </strong>
        </article>
        <article className="chart-stat">
          <span className="chart-stat__label">{t('profileEscrowLabel')}</span>
          <strong className="chart-stat__value">
            {t('profileEscrow').replace('{value}', formatIsk(totals.escrowTotal, locale))}
          </strong>
        </article>
      </div>
      {orders.length === 0 ? <p className="profile-panel__empty">{t('profileOrdersEmpty')}</p> : null}
      {orders.length > 0 ? (
        <div className="profile-table">
          <table>
            <thead>
              <tr>
                <th>{t('profileItem')}</th>
                <th>{t('marketRegion')}</th>
                <th>{t('marketLocation')}</th>
                <th className="num">{t('marketPrice')}</th>
                <th className="num">{t('profileOrderVolume')}</th>
                <th>{t('marketAlertSide')}</th>
                <th>{t('profileIssued')}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.orderId}>
                  <td>{order.typeName ?? `#${order.typeId}`}</td>
                  <td>{order.regionName ?? '—'}</td>
                  <td>
                    {order.locationId === null
                      ? '—'
                      : order.locationKind === 'structure'
                        ? t('profileStructure')
                        : order.locationName ?? t('profileUnknownLocation')}
                  </td>
                  <td className="num">{order.price === null ? '—' : formatIsk(order.price, locale, { compact: false })}</td>
                  <td className="num">
                    {order.volumeRemain === null || order.volumeTotal === null
                      ? '—'
                      : `${formatQuantity(order.volumeRemain, locale)} / ${formatQuantity(order.volumeTotal, locale)}`}
                  </td>
                  <td className={order.isBuyOrder ? 'order-side order-side--buy' : 'order-side order-side--sell'}>
                    {order.isBuyOrder ? t('marketBuySide') : t('marketSellSide')}
                  </td>
                  <td>{formatLocalDateTime(order.issued, locale) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {orders.length < total ? (
        <button className="button profile-panel__more" type="button" disabled={loadingMore} onClick={() => void showMore()}>
          {t('marketShowMore')}
        </button>
      ) : null}
    </section>
  );
}
