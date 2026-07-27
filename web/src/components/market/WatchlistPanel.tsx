import { useCallback, useEffect, useRef, useState } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import { CloseIcon } from '../../icons';
import type { MarketWatchlistItem } from '../../types';
import { formatIsk } from './format';

type SelectedType = { typeId: number; name: string };

type Props = {
  selectedType: SelectedType | null;
  regionId: number | null;
  csrfToken: string;
  onSelect: (typeId: number, name: string) => void;
};

/**
 * Вотчлист с live-ценами из локального снапшота. Клик по строке выбирает
 * товар в основном экране; «добавить текущий товар» привязан к текущему
 * региону тулбара и выключен, когда пара (type, region) уже в списке.
 * Лимит 100 позиций приходит 409 — текст сервера показываем как есть.
 */
export function WatchlistPanel({ selectedType, regionId, csrfToken, onSelect }: Props) {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<MarketWatchlistItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const payload = await webApi.market.watchlist.list();
      if (current !== generation.current) return;
      setItems(payload.items);
    } catch (reason) {
      if (current !== generation.current) return;
      setItems(null);
      setError(reason instanceof Error ? reason.message : t('requestFailed'));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const alreadyWatched = selectedType !== null && regionId !== null
    && Boolean(items?.some((item) => item.type_id === selectedType.typeId && item.region_id === regionId));
  const canAdd = selectedType !== null && regionId !== null && items !== null && !alreadyWatched && !adding;

  const addCurrent = async () => {
    if (!canAdd || selectedType === null || regionId === null) return;
    setAdding(true);
    setMutationError(null);
    try {
      const payload = await webApi.market.watchlist.add(selectedType.typeId, regionId, csrfToken);
      setItems((current) => {
        const base = current ?? [];
        return payload.created || !base.some((item) => item.type_id === payload.item.type_id && item.region_id === payload.item.region_id)
          ? [...base, payload.item]
          : base;
      });
    } catch (reason) {
      setMutationError(reason instanceof Error ? reason.message : t('requestFailed'));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (item: MarketWatchlistItem) => {
    const key = `${item.type_id}:${item.region_id}`;
    setRemovingKey(key);
    setMutationError(null);
    try {
      await webApi.market.watchlist.remove(item.type_id, item.region_id, csrfToken);
      setItems((current) => current?.filter((entry) => `${entry.type_id}:${entry.region_id}` !== key) ?? null);
    } catch (reason) {
      setMutationError(reason instanceof Error ? reason.message : t('requestFailed'));
    } finally {
      setRemovingKey(null);
    }
  };

  return (
    <section className="watchlist" aria-label={t('marketWatchlistTitle')}>
      <header className="watchlist__header">
        <h3 className="watchlist__title">{t('marketWatchlistTitle')}</h3>
        <button type="button" className="button" disabled={!canAdd} onClick={() => void addCurrent()}>
          {adding ? `${t('loading')}…` : t('marketWatchlistAdd')}
        </button>
      </header>
      {mutationError ? <p className="watchlist__error" role="alert">{mutationError}</p> : null}
      {items === null && !error ? <div className="panel-loading">{t('loading')}…</div> : null}
      {error ? (
        <div className="workspace-error" role="alert">
          {error}
          <button type="button" onClick={() => void load()}>{t('retry')}</button>
        </div>
      ) : null}
      {items !== null && items.length === 0 ? (
        <p className="watchlist__empty">{t('marketWatchlistEmpty')}</p>
      ) : null}
      {items !== null && items.length > 0 ? (
        <div className="watchlist__table">
          <div className="watchlist__row watchlist__row--head">
            <div className="watchlist__head-grid">
              <span>{t('marketWatchlistItem')}</span>
              <span className="watchlist__price">{t('marketBestSell')}</span>
              <span className="watchlist__price">{t('marketBestBuy')}</span>
            </div>
            <span className="watchlist__remove-space" aria-hidden="true" />
          </div>
          <ul className="watchlist__list">
            {items.map((item) => {
              const key = `${item.type_id}:${item.region_id}`;
              return (
                <li className="watchlist__row" key={key}>
                  <button
                    type="button"
                    className="watchlist__item"
                    onClick={() => onSelect(item.type_id, item.type_name ?? `#${item.type_id}`)}
                  >
                    <span className="watchlist__name">{item.type_name ?? `#${item.type_id}`}</span>
                    <span className="watchlist__price watchlist__price--sell">{formatIsk(item.best_sell, locale)}</span>
                    <span className="watchlist__price watchlist__price--buy">{formatIsk(item.best_buy, locale)}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button watchlist__remove"
                    aria-label={t('marketWatchlistRemove')}
                    disabled={removingKey === key}
                    onClick={() => void remove(item)}
                  >
                    <CloseIcon size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
