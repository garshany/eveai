import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { webApi } from '../../api';
import { useI18n, type Locale } from '../../i18n';
import { CloseIcon } from '../../icons';
import type { MarketAlert, MarketAlertEvent, MarketOrderSide } from '../../types';
import { formatIsk } from './format';

type SelectedType = { typeId: number; name: string };

type Props = {
  selectedType: SelectedType | null;
  regionId: number | null;
  csrfToken: string;
  bestSell: number | null;
  bestBuy: number | null;
};

/**
 * Ценовые алерты: форма создания (сторона/условие/порог, регион — текущий из
 * тулбара), список активных с дистанцией до срабатывания и лента сработавших
 * из alerts/events (delivered_at — признак push-доставки). DELETE на сервере
 * мягкий (status='disabled'), поэтому строку просто убираем из состояния.
 */
export function AlertsPanel({ selectedType, regionId, csrfToken, bestSell, bestBuy }: Props) {
  const { locale, t } = useI18n();
  const [alerts, setAlerts] = useState<MarketAlert[] | null>(null);
  const [events, setEvents] = useState<MarketAlertEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [side, setSide] = useState<MarketOrderSide>('sell');
  const [comparator, setComparator] = useState<'above' | 'below'>('below');
  const [threshold, setThreshold] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const [alertsPayload, eventsPayload] = await Promise.all([
        webApi.market.alerts.list(),
        webApi.market.alerts.events(),
      ]);
      if (current !== generation.current) return;
      setAlerts(alertsPayload.alerts);
      setEvents(eventsPayload.events);
    } catch (reason) {
      if (current !== generation.current) return;
      setAlerts(null);
      setError(reason instanceof Error ? reason.message : t('requestFailed'));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const currentBest = side === 'sell' ? bestSell : bestBuy;
  const thresholdPrice = Number(threshold);
  const thresholdValid = threshold.trim() !== '' && Number.isFinite(thresholdPrice) && thresholdPrice > 0;
  const canSubmit = selectedType !== null && regionId !== null && thresholdValid && !submitting;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || selectedType === null || regionId === null) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const payload = await webApi.market.alerts.create(
        { typeId: selectedType.typeId, regionId, side, comparator, thresholdPrice },
        csrfToken,
      );
      setAlerts((current) => [payload.alert, ...(current ?? [])]);
      setThreshold('');
    } catch (reason) {
      // 400/404/409 приходят с русским текстом сервера в {error} — показываем как есть.
      setFormError(reason instanceof Error ? reason.message : t('requestFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (alert: MarketAlert) => {
    setRemovingId(alert.alert_id);
    setFormError(null);
    try {
      await webApi.market.alerts.remove(alert.alert_id, csrfToken);
      setAlerts((current) => current?.filter((entry) => entry.alert_id !== alert.alert_id) ?? null);
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : t('requestFailed'));
    } finally {
      setRemovingId(null);
    }
  };

  const active = (alerts ?? []).filter((alert) => alert.status === 'active');

  return (
    <section className="alerts" aria-label={t('marketAlertsTitle')}>
      <h3 className="alerts__title">{t('marketAlertsTitle')}</h3>
      <form className="alerts__form" onSubmit={(event) => void submit(event)}>
        <label className="alerts__field">
          <span className="alerts__label">{t('marketAlertSide')}</span>
          <select className="market-select" value={side} onChange={(event) => setSide(event.target.value === 'buy' ? 'buy' : 'sell')}>
            <option value="sell">{t('marketSellSide')}</option>
            <option value="buy">{t('marketBuySide')}</option>
          </select>
        </label>
        <label className="alerts__field">
          <span className="alerts__label">{t('marketAlertCondition')}</span>
          <select className="market-select" value={comparator} onChange={(event) => setComparator(event.target.value === 'above' ? 'above' : 'below')}>
            <option value="below">{t('marketAlertBelow')}</option>
            <option value="above">{t('marketAlertAbove')}</option>
          </select>
        </label>
        <label className="alerts__field alerts__field--grow">
          <span className="alerts__label">{t('marketAlertThreshold')}</span>
          <input
            className="market-input"
            type="number"
            min="0"
            step="any"
            value={threshold}
            placeholder={currentBest !== null ? formatIsk(currentBest, locale, { compact: false }) : undefined}
            disabled={selectedType === null || regionId === null}
            onChange={(event) => setThreshold(event.target.value)}
          />
        </label>
        <button type="submit" className="button" disabled={!canSubmit}>
          {submitting ? `${t('loading')}…` : t('marketAlertCreate')}
        </button>
      </form>
      {selectedType === null ? <p className="alerts__hint">{t('marketAlertNoItem')}</p> : null}
      {formError ? <p className="alerts__error" role="alert">{formError}</p> : null}
      {alerts === null && !error ? <div className="panel-loading">{t('loading')}…</div> : null}
      {error ? (
        <div className="workspace-error" role="alert">
          {error}
          <button type="button" onClick={() => void load()}>{t('retry')}</button>
        </div>
      ) : null}
      {alerts !== null ? (
        <>
          <h4 className="alerts__section">{t('marketAlertActive')}</h4>
          {active.length === 0 ? <p className="alerts__empty">{t('marketAlertEmpty')}</p> : null}
          <ul className="alerts__list">
            {active.map((alert) => (
              <li className="alerts__row" key={alert.alert_id}>
                <div className="alerts__main">
                  <span className="alerts__type">{alert.type_name ?? `#${alert.type_id}`}</span>
                  <span className="alerts__condition">
                    {`${alert.side === 'sell' ? t('marketSellSide') : t('marketBuySide')} ${alert.comparator === 'below' ? '≤' : '≥'} ${formatIsk(alert.threshold_price, locale)}`}
                  </span>
                  {alert.region_name ? <span className="alerts__region">{alert.region_name}</span> : null}
                </div>
                <div className="alerts__meta">
                  <span>{t('marketAlertBestNow')}: {formatIsk(alert.best_price, locale)}</span>
                  <span>{distanceText(alert, locale, t('marketAlertDistance'), t('marketAlertThresholdCrossed'))}</span>
                </div>
                <button
                  type="button"
                  className="icon-button alerts__remove"
                  aria-label={t('marketAlertDelete')}
                  disabled={removingId === alert.alert_id}
                  onClick={() => void remove(alert)}
                >
                  <CloseIcon size={16} />
                </button>
              </li>
            ))}
          </ul>
          <h4 className="alerts__section">{t('marketAlertTriggered')}</h4>
          {events.length === 0 ? <p className="alerts__empty">{t('marketAlertTriggeredEmpty')}</p> : null}
          <ul className="alerts__list">
            {events.map((event) => (
              <li className="alerts__row alerts__row--event" key={event.event_id}>
                <div className="alerts__main">
                  <span className="alerts__type">{event.type_name ?? `#${event.type_id}`}</span>
                  <span className="alerts__condition">
                    {`${formatIsk(event.price, locale)} · ${formatDateTime(event.triggered_at, locale)}`}
                  </span>
                  {event.region_name ? <span className="alerts__region">{event.region_name}</span> : null}
                </div>
                <span className={`alerts__delivery${event.delivered_at ? ' alerts__delivery--push' : ''}`}>
                  {event.delivered_at ? t('marketAlertDelivered') : t('marketAlertWebOnly')}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/**
 * Насколько текущей best-цене не хватает до порога, в процентах от неё:
 * для 'below' — насколько цене падать, для 'above' — насколько расти.
 * Цена уже могла пересечь порог до тика воркера — тогда дистанция
 * отрицательная и вместо неё показываем crossedText.
 */
function distanceText(alert: MarketAlert, locale: Locale, template: string, crossedText: string): string {
  if (alert.best_price === null || alert.best_price <= 0) return '—';
  const distance = alert.comparator === 'below'
    ? ((alert.best_price - alert.threshold_price) / alert.best_price) * 100
    : ((alert.threshold_price - alert.best_price) / alert.best_price) * 100;
  if (distance < 0) return crossedText;
  const pct = `${new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 1 }).format(distance)}%`;
  return template.replace('{pct}', pct);
}

/** created_at/triggered_at — UTC-строки SQLite ('YYYY-MM-DD HH:MM:SS'). */
function formatDateTime(value: string, locale: Locale): string {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
