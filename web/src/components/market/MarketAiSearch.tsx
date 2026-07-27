import { useEffect, useRef, useState, type FormEvent } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { MarketAiSearchResult } from '../../types';
import { formatIsk } from './format';

type Props = {
  regionId: number | null;
  csrfToken: string;
  onSelect: (typeId: number, name: string) => void;
};

/**
 * АИ-подбор предметов естественным языком. Запрос уходит в
 * /api/web/market/ai-search (модель + тулы на сервере, секунды ожидания) —
 * честно показываем «думаю…», ошибку модели и пустой результат. Цены на
 * карточках — из локального снапшота в текущем регионе тулбара.
 */
export function MarketAiSearch({ regionId, csrfToken, onSelect }: Props) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MarketAiSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  // Смена региона инвалидирует выдачу: цены и «лучший ордер» на карточках
  // посчитаны по старому региону и в новом вводили бы в заблуждение. Заодно
  // гасим in-flight запрос к старому региону через generation.
  useEffect(() => {
    generation.current += 1;
    setResults(null);
    setError(null);
    setSearching(false);
  }, [regionId]);

  const run = async () => {
    const needle = query.trim();
    if (needle.length < 2 || searching) return;
    const current = ++generation.current;
    setSearching(true);
    setError(null);
    try {
      const payload = await webApi.market.aiSearch(needle, regionId, csrfToken);
      if (current !== generation.current) return;
      setResults(payload.results);
    } catch (reason) {
      if (current !== generation.current) return;
      setResults(null);
      setError(reason instanceof Error ? reason.message : t('requestFailed'));
    } finally {
      if (current === generation.current) setSearching(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run();
  };

  return (
    <section className="market-ai" aria-label={t('marketAiTitle')}>
      <form className="market-ai__form" onSubmit={submit}>
        <input
          className="market-input"
          type="search"
          value={query}
          maxLength={500}
          placeholder={t('marketAiPlaceholder')}
          aria-label={t('marketAiTitle')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="button" type="submit" disabled={searching || query.trim().length < 2}>
          {t('marketAiButton')}
        </button>
      </form>
      {searching ? <p className="market-ai__status" role="status">{t('marketAiThinking')}</p> : null}
      {error ? (
        <div className="workspace-error" role="alert">
          {error}
          <button type="button" onClick={() => void run()}>{t('retry')}</button>
        </div>
      ) : null}
      {!searching && !error && results !== null && results.length === 0 ? (
        <p className="market-ai__status">{t('marketAiEmpty')}</p>
      ) : null}
      {!searching && results !== null && results.length > 0 ? (
        <div className="market-ai__results">
          {results.map((item) => (
            <article className="market-ai__card" key={item.type_id}>
              <span className="market-ai__card-name">{item.name}</span>
              {item.reason ? <p className="market-ai__card-reason">{item.reason}</p> : null}
              <div className="market-ai__card-prices">
                <span className="market-ai__price--sell" title={t('marketBestSell')}>{formatIsk(item.best_sell, locale)}</span>
                <span className="market-ai__price--buy" title={t('marketBestBuy')}>{formatIsk(item.best_buy, locale)}</span>
              </div>
              <button type="button" className="button" onClick={() => onSelect(item.type_id, item.name)}>
                {t('marketAiOpen')}
              </button>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
