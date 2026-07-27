import { useCallback, useEffect, useRef, useState } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { MarketOrderRow, MarketOrderSide } from '../../types';
import { formatIsk, formatQuantity } from './format';

// Совпадает с ORDERS_DEFAULT_LIMIT на сервере (src/web/market-routes.ts);
// hasMore вычисляется по полной странице.
const PAGE_SIZE = 50;

type SideState = {
  rows: MarketOrderRow[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  initialized: boolean;
};

const EMPTY_SIDE: SideState = { rows: [], loading: false, error: null, hasMore: false, initialized: false };

type Props = {
  typeId: number;
  regionId: number;
};

/**
 * Две колонки ордер-бука (продажа/покупка) в сортировке API: sell по цене
 * ASC, buy по цене DESC. «Показать ещё» догружает страницы по offset.
 * location_name NULL — ордер в player structure (имена резолвятся только
 * для NPC-станций), система показана через system_name.
 */
export function OrderBookTable({ typeId, regionId }: Props) {
  const { locale, t } = useI18n();
  const [sides, setSides] = useState<Record<MarketOrderSide, SideState>>({ sell: EMPTY_SIDE, buy: EMPTY_SIDE });
  const generation = useRef(0);

  const loadSide = useCallback(async (side: MarketOrderSide, offset: number, append: boolean) => {
    const current = generation.current;
    setSides((prev) => ({ ...prev, [side]: { ...prev[side], loading: true, error: null } }));
    try {
      const payload = await webApi.market.orders(typeId, regionId, side, offset);
      if (current !== generation.current) return;
      setSides((prev) => ({
        ...prev,
        [side]: {
          rows: append ? [...prev[side].rows, ...payload.orders] : payload.orders,
          loading: false,
          error: null,
          hasMore: payload.orders.length === PAGE_SIZE,
          initialized: true,
        },
      }));
    } catch (reason) {
      if (current !== generation.current) return;
      setSides((prev) => ({
        ...prev,
        [side]: {
          ...prev[side],
          loading: false,
          error: reason instanceof Error ? reason.message : t('requestFailed'),
          initialized: true,
        },
      }));
    }
  }, [typeId, regionId, t]);

  useEffect(() => {
    generation.current += 1;
    setSides({ sell: EMPTY_SIDE, buy: EMPTY_SIDE });
    void loadSide('sell', 0, false);
    void loadSide('buy', 0, false);
  }, [loadSide]);

  const renderSide = (side: MarketOrderSide) => {
    const state = sides[side];
    return (
      <section className={`order-book__column order-book__column--${side}`}>
        <h3 className="order-book__title">{side === 'sell' ? t('marketSellSide') : t('marketBuySide')}</h3>
        <div className="order-book__row order-book__row--head">
          <span>{t('marketPrice')}</span>
          <span>{t('marketQuantity')}</span>
          <span>{t('marketLocation')}</span>
        </div>
        {state.rows.map((order) => (
          <div className="order-book__row" key={order.order_id}>
            <span className={`order-book__price order-book__price--${side}`}>{formatIsk(order.price, locale, { compact: false })}</span>
            <span className="order-book__qty">{formatQuantity(order.volume_remain, locale)}</span>
            <span className="order-book__location">
              {order.location_name ?? t('marketPlayerStructure')}
              {order.system_name ? <small>{order.system_name}</small> : null}
            </span>
          </div>
        ))}
        {state.initialized && !state.loading && !state.error && state.rows.length === 0
          ? <p className="order-book__empty">{t('marketNoOrders')}</p>
          : null}
        {state.loading ? <p className="order-book__loading">{t('loading')}…</p> : null}
        {state.error ? <p className="order-book__error" role="alert">{state.error}</p> : null}
        {state.hasMore ? (
          <button
            type="button"
            className="button order-book__more"
            disabled={state.loading}
            onClick={() => void loadSide(side, state.rows.length, true)}
          >
            {t('marketShowMore')}
          </button>
        ) : null}
      </section>
    );
  };

  return <div className="order-book">{renderSide('sell')}{renderSide('buy')}</div>;
}
