import { useEffect, useState } from 'react';
import { webApi } from '../api';
import { CloseIcon } from '../icons';
import { useI18n } from '../i18n';
import type {
  ActivityStep,
  MarketAlertEvent,
  MarketHistoryPoint,
  MarketRegion,
  MarketWatchlistItem,
  PilotProfile,
  ProfileClonesResponse,
  ProfileOrdersResponse,
} from '../types';

export type DockTab = 'market' | 'route' | 'pilot';

type Props = {
  tab: DockTab;
  trace: ActivityStep[] | null;
  /** Owned by App so the sidebar caption and the dock share one ESI read. */
  profile: PilotProfile | null;
  hasCharacter: boolean;
  onTab: (tab: DockTab) => void;
  onClose: () => void;
  /** Dock rows seed the composer, mirroring the examples screen's draft path. */
  onAsk: (question: string) => void;
};

export function DataDock({ tab, trace, profile, hasCharacter, onTab, onClose, onAsk }: Props) {
  const { t } = useI18n();
  const tabs: Array<{ id: DockTab; label: string }> = [
    { id: 'market', label: t('dockTabMarket') },
    { id: 'route', label: t('dockTabRoute') },
    { id: 'pilot', label: t('dockTabPilot') },
  ];
  return <aside className="dock" aria-label={t('dockOpen')}>
    <div className="dock__tabs" role="tablist">
      {tabs.map(({ id, label }) => <button
        className={`dock__tab${tab === id ? ' dock__tab--active' : ''}`}
        type="button"
        key={id}
        role="tab"
        aria-selected={tab === id}
        onClick={() => onTab(id)}
      >{label}</button>)}
    </div>
    <button className="icon-button dock__close" type="button" onClick={onClose} aria-label={t('dockClose')}><CloseIcon size={18} /></button>
    <div className="dock__body" role="tabpanel">
      {tab === 'market' ? <MarketTab hasCharacter={hasCharacter} onAsk={onAsk} /> : null}
      {tab === 'route' ? <RouteTab trace={trace} /> : null}
      {tab === 'pilot' ? <PilotTab profile={profile} hasCharacter={hasCharacter} onAsk={onAsk} /> : null}
    </div>
  </aside>;
}

/* --- Маркет --------------------------------------------------------------- */

function MarketTab({ hasCharacter, onAsk }: { hasCharacter: boolean; onAsk: (question: string) => void }) {
  const { t, locale } = useI18n();
  const [regions, setRegions] = useState<MarketRegion[]>([]);
  const [regionId, setRegionId] = useState<number | null>(null);
  const [watchlist, setWatchlist] = useState<MarketWatchlistItem[]>([]);
  const [history, setHistory] = useState<MarketHistoryPoint[] | null>(null);
  const [historyChange, setHistoryChange] = useState<number | null>(null);
  const [historyLabel, setHistoryLabel] = useState<string | null>(null);
  const [orders, setOrders] = useState<ProfileOrdersResponse | null>(null);
  const [events, setEvents] = useState<MarketAlertEvent[]>([]);

  // Каждая ветка гасит свою ошибку в пустое состояние: док — сопровождающая
  // панель, он не имеет права уронить тред из-за отсутствующего ESI-скоупа.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [regionsResult, watchlistResult, eventsResult] = await Promise.allSettled([
        webApi.market.regions(),
        webApi.market.watchlist.list(),
        webApi.market.alerts.events(),
      ]);
      if (cancelled) return;
      if (regionsResult.status === 'fulfilled') {
        setRegions(regionsResult.value.regions);
        // regions[0]: сервер сортирует торговые регионы по размеру — первый The Forge.
        setRegionId((current) => current ?? regionsResult.value.regions[0]?.region_id ?? null);
      }
      if (watchlistResult.status === 'fulfilled') setWatchlist(watchlistResult.value.items);
      if (eventsResult.status === 'fulfilled') setEvents(eventsResult.value.events);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hasCharacter) return;
    let cancelled = false;
    void webApi.profile.orders(0, 1)
      .then((result) => { if (!cancelled) setOrders(result); })
      .catch(() => { /* нет скоупа или синка — счётчики просто не показываем */ });
    return () => { cancelled = true; };
  }, [hasCharacter]);

  const leadItem = watchlist.find((item) => regionId === null || item.region_id === regionId) ?? watchlist[0] ?? null;
  const leadTypeId = leadItem?.type_id ?? null;
  const leadRegionId = leadItem?.region_id ?? null;
  const leadName = leadItem?.type_name ?? null;

  useEffect(() => {
    if (leadTypeId === null || leadRegionId === null) {
      setHistory(null);
      setHistoryChange(null);
      setHistoryLabel(null);
      return;
    }
    let cancelled = false;
    void webApi.market.history(leadTypeId, leadRegionId, 30)
      .then(({ history: payload }) => {
        if (cancelled) return;
        setHistory(payload.series);
        setHistoryChange(payload.stats.change_30d_percent);
        setHistoryLabel(leadName);
      })
      .catch(() => { if (!cancelled) setHistory(null); });
    return () => { cancelled = true; };
  }, [leadTypeId, leadRegionId, leadName]);

  const visible = watchlist.filter((item) => regionId === null || item.region_id === regionId).slice(0, 6);
  const regionName = regions.find((region) => region.region_id === regionId)?.name ?? null;
  const latestEvent = events[0] ?? null;

  return <>
    <div className="dock-card dock-card--pad">
      <div className="dock-region">
        <div className="dock-region__copy">
          <span className="dock-label">{t('dockRegion')}</span>
          <span className="dock-region__value">{regionName ?? '—'}</span>
        </div>
        <button className="dock-pill" type="button" onClick={() => onAsk(t('dockPromptMarket'))}>{t('dockChangeRegion')}</button>
      </div>
      {regions.length > 1 ? <select
        className="dock-region__select"
        value={regionId ?? ''}
        aria-label={t('dockRegion')}
        onChange={(event) => setRegionId(Number(event.target.value))}
      >{regions.map((region) => <option value={region.region_id} key={region.region_id}>{region.name}</option>)}</select> : null}
    </div>

    <div className="dock-card">
      <div className="dock-table__head">
        <span>{t('dockItem')}</span>
        <span className="dock-table__num">{t('dockSell')}</span>
        <span className="dock-table__num">{t('dockDelta')}</span>
      </div>
      {visible.length ? <div className="dock-table__body">
        {visible.map((item) => <button
          className="dock-table__row"
          type="button"
          key={`${item.type_id}-${item.region_id}`}
          onClick={() => onAsk(`${item.type_name ?? `#${item.type_id}`}: ${t('dockPromptMarket')}`)}
        >
          <span className="dock-table__name">{item.type_name ?? `#${item.type_id}`}</span>
          <span className="dock-table__num">{formatIsk(item.best_sell, locale)}</span>
          <span className={`dock-table__num${spreadTone(item)}`}>{formatSpread(item)}</span>
        </button>)}
      </div> : <p className="dock-empty">{t('dockWatchlistEmpty')}</p>}
    </div>

    {history?.length ? <div className="dock-card">
      <div className="dock-chart">
        <div className="dock-chart__head">
          <span className="dock-label">{historyLabel ?? ''} · 30{locale === 'ru' ? 'д' : 'd'}</span>
          {historyChange === null ? null : <span className={`dock-chart__change dock-chart__change--${historyChange >= 0 ? 'pos' : 'neg'}`}>{formatPercent(historyChange)}</span>}
        </div>
        <HistoryBars series={history} />
      </div>
    </div> : null}

    {orders ? <div className="dock-stats">
      <div className="dock-stat">
        <span className="dock-label">{t('dockMyOrders')}</span>
        <span className="dock-stat__value">{orders.total}</span>
      </div>
      <div className="dock-stat">
        <span className="dock-label">{t('dockEscrow')}</span>
        <span className="dock-stat__value dock-stat__value--sm">{formatIsk(orders.totals.escrowTotal, locale)}</span>
      </div>
    </div> : null}

    {latestEvent ? <div className="dock-alert">
      <span className="dock-alert__dot" aria-hidden="true" />
      <span>{t('dockAlertCrossed')
        .replace('{name}', latestEvent.type_name ?? `#${latestEvent.type_id}`)
        .replace('{price}', formatIsk(latestEvent.threshold, locale))}</span>
    </div> : null}
  </>;
}

/** Гистограмма средней цены за 30 дней: чем правее столбик, тем «горячее» цвет. */
function HistoryBars({ series }: { series: MarketHistoryPoint[] }) {
  const points = series.slice(-11);
  const values = points.map((point) => point.average);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  return <div className="dock-chart__bars" aria-hidden="true">
    {points.map((point, index) => {
      const ratio = index / Math.max(1, points.length - 1);
      const tone = ratio > 0.78 ? ' dock-chart__bar--live' : ratio > 0.55 ? ' dock-chart__bar--warm' : ratio > 0.28 ? ' dock-chart__bar--mid' : '';
      const height = 26 + Math.round(((point.average - min) / span) * 74);
      return <div className={`dock-chart__bar${tone}`} key={point.date} style={{ height: `${height}%` }} />;
    })}
  </div>;
}

/* --- Маршрут: сырые вызовы инструментов из последнего ответа --------------- */

function RouteTab({ trace }: { trace: ActivityStep[] | null }) {
  const { t } = useI18n();
  if (!trace?.length) return <p className="dock-empty">{t('dockRouteEmpty')}</p>;
  return <>
    <div className="dock-card dock-card--pad">
      <span className="dock-label">{t('dockRouteTitle')}</span>
      <p className="dock-trace__detail" style={{ marginTop: '6px' }}>{t('dockRouteHint')}</p>
    </div>
    {trace.map((step, index) => <div className="dock-card" key={`${step.name}-${index}`}>
      <div className="dock-trace">
        <span className="dock-trace__name">{step.name}</span>
        {step.detail ? <span className="dock-trace__detail">{step.detail}</span> : null}
      </div>
    </div>)}
  </>;
}

/* --- Капсулёр ------------------------------------------------------------- */

function PilotTab({ profile, hasCharacter, onAsk }: { profile: PilotProfile | null; hasCharacter: boolean; onAsk: (question: string) => void }) {
  const { t, locale } = useI18n();
  const [clones, setClones] = useState<ProfileClonesResponse | null>(null);

  // Профиль приезжает из App; здесь дочитываем только клоны — их не нужно
  // держать в общем состоянии ради одной строки в карточке.
  useEffect(() => {
    if (!hasCharacter) return;
    let cancelled = false;
    void webApi.profile.clones()
      .then((result) => { if (!cancelled) setClones(result); })
      .catch(() => { /* нет скоупа clones — покажем прочерк */ });
    return () => { cancelled = true; };
  }, [hasCharacter]);

  if (!hasCharacter || !profile) return <p className="dock-empty">{t('dockPilotGuest')}</p>;

  const sp = profile.skills ? (profile.skills.totalSp / 1_000_000).toFixed(1) : null;
  const inSpace = profile.location?.solarSystemName ?? null;
  const meta = [sp ? t('dockSp').replace('{sp}', sp) : null, profile.online ? t('dockOmega') : null]
    .filter((part): part is string => Boolean(part)).join(' · ');

  return <>
    <div className="dock-identity">
      <span className="dock-identity__portrait" aria-hidden="true">
        {profile.character.portraitUrl ? <img src={profile.character.portraitUrl} alt="" /> : profile.character.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="dock-identity__copy">
        <span className="dock-identity__name">{profile.character.name}</span>
        <span className="dock-identity__corp">{[profile.corporation?.name, profile.alliance?.name].filter(Boolean).join(' · ') || '—'}</span>
        {meta ? <span className="dock-identity__meta">{meta}</span> : null}
      </span>
    </div>

    <div className="dock-stats">
      <div className="dock-stat">
        <span className="dock-label">{t('dockWallet')}</span>
        <span className="dock-stat__value dock-stat__value--sm">{profile.wallet ? formatIsk(profile.wallet.balance, locale) : '—'}</span>
      </div>
      <div className="dock-stat">
        <span className="dock-label">{t('dockClone')}</span>
        <span className="dock-stat__value dock-stat__value--sm">{clones?.home?.locationName ?? '—'}</span>
      </div>
    </div>

    <div className="dock-card">
      <div className="dock-ship">
        <div className="dock-ship__head">
          <span className="dock-label">{t('dockActiveShip')}</span>
          <span className={`dock-ship__state${inSpace ? ' dock-ship__state--space' : ''}`}>{inSpace ? `${t('dockInSpace')} · ${inSpace}` : t('dockDocked')}</span>
        </div>
        <div className="dock-ship__row">
          <span className="dock-ship__thumb" aria-hidden="true">
            {profile.ship ? <img src={`https://images.evetech.net/types/${profile.ship.typeId}/render?size=64`} alt="" loading="lazy" /> : null}
          </span>
          <span className="dock-ship__copy">
            <span className="dock-ship__name">{profile.ship?.name ?? profile.ship?.typeName ?? '—'}</span>
            <span className="dock-ship__class">{profile.ship?.typeName ?? ''}</span>
          </span>
        </div>
      </div>
    </div>

    <div className="dock-prompts">
      <button className="dock-prompt dock-prompt--primary" type="button" onClick={() => onAsk(t('dockPromptLosses'))}>{t('dockPromptLosses')}</button>
      <button className="dock-prompt" type="button" onClick={() => onAsk(t('dockPromptRefit'))}>{t('dockPromptRefit')}</button>
    </div>
  </>;
}

/* --- Формат --------------------------------------------------------------- */

function formatIsk(value: number | null, locale: 'ru' | 'en'): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const nbsp = locale === 'ru' ? ' ' : ' ';
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}${nbsp}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}${nbsp}M`;
  if (abs >= 1_000) return new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 0 }).format(value);
  return new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 2 }).format(value);
}

/** Спред sell/buy — единственная «дельта», которую вотчлист отдаёт без второго
 *  запроса истории на каждую строку; 24-часовой дельты в этом контракте нет. */
function watchlistSpread(item: MarketWatchlistItem): number | null {
  if (item.best_sell === null || item.best_buy === null || item.best_sell === 0) return null;
  return ((item.best_sell - item.best_buy) / item.best_sell) * 100;
}

function formatSpread(item: MarketWatchlistItem): string {
  const spread = watchlistSpread(item);
  return spread === null ? '—' : formatPercent(spread);
}

function spreadTone(item: MarketWatchlistItem): string {
  const spread = watchlistSpread(item);
  if (spread === null) return ' dock-table__num--muted';
  return spread >= 10 ? ' dock-table__num--pos' : ' dock-table__num--neg';
}

function formatPercent(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}%`;
}
