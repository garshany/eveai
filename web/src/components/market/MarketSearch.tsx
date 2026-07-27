import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { MarketTypeSearchRow } from '../../types';
import { cachedMarketStatic } from './static-cache';

const SEARCH_DEBOUNCE_MS = 250;
// Совпадает с SEARCH_MIN_QUERY_LENGTH на сервере (src/web/market-routes.ts).
const SEARCH_MIN_LENGTH = 2;

type Props = {
  onSelect: (typeId: number, name: string) => void;
  disabled?: boolean;
};

/**
 * Поиск товара с debounce и клавиатурной навигацией (стрелки/Enter/Esc).
 * generation защищает от гонок: поздний ответ не перезаписывает свежий.
 */
export function MarketSearch({ onSelect, disabled }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MarketTypeSearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const generation = useRef(0);
  // Подстановка выбранного имени в query не должна перезапускать поиск.
  const suppressNextSearch = useRef(false);

  useEffect(() => {
    if (suppressNextSearch.current) {
      suppressNextSearch.current = false;
      setSearching(false);
      return;
    }
    const needle = query.trim();
    if (needle.length < SEARCH_MIN_LENGTH) {
      generation.current += 1;
      setResults([]);
      setSearching(false);
      setActiveIndex(-1);
      setOpen(false);
      return;
    }
    const current = ++generation.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      // Повторные запросы (стирание/возврат к строке) обслуживаются из
      // кэша вкладки — справочник типов в рамках сессии неизменен.
      cachedMarketStatic(`search:${needle.toLowerCase()}`, () => webApi.market.search(needle))
        .then((payload) => {
          if (current !== generation.current) return;
          setResults(payload.results);
          setActiveIndex(payload.results.length > 0 ? 0 : -1);
          setOpen(true);
        })
        .catch(() => {
          if (current !== generation.current) return;
          setResults([]);
          setOpen(true);
        })
        .finally(() => {
          if (current === generation.current) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const choose = (row: MarketTypeSearchRow) => {
    suppressNextSearch.current = true;
    generation.current += 1; // ответ уже ушедшего запроса не должен примениться
    setQuery(row.name);
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
    onSelect(row.type_id, row.name);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (results.length > 0) {
        setOpen(true);
        setActiveIndex((index) => Math.min(index + 1, results.length - 1));
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      const row = activeIndex >= 0 ? results[activeIndex] : results[0];
      if (open && row) {
        event.preventDefault();
        choose(row);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div
      className="market-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        className="market-input market-search__input"
        type="search"
        value={query}
        disabled={disabled}
        placeholder={t('marketSearchPlaceholder')}
        aria-label={t('marketSearchPlaceholder')}
        role="combobox"
        aria-expanded={open}
        aria-controls="market-search-listbox"
        aria-autocomplete="list"
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      {query.trim().length === 1 ? <p className="market-search__hint">{t('marketSearchHint')}</p> : null}
      {open ? (
        <div className="market-search__dropdown" role="listbox" id="market-search-listbox">
          {results.length === 0 ? (
            <p className="market-search__empty">{searching ? `${t('loading')}…` : t('marketSearchEmpty')}</p>
          ) : results.map((row, index) => (
            <button
              key={row.type_id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`market-search__option${index === activeIndex ? ' market-search__option--active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(row)}
            >
              {row.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
