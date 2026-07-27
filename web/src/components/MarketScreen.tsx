import { useCallback, useEffect, useRef, useState } from 'react';
import { webApi } from '../api';
import { LocaleSwitch, useI18n } from '../i18n';
import { MarketIcon, MenuIcon } from '../icons';
import type { MarketOverview, MarketRegion, MarketSnapshotMeta } from '../types';
import { AlertsPanel } from './market/AlertsPanel';
import { MarketGroupsTree } from './market/MarketGroupsTree';
import { MarketOverview as MarketOverviewPanel } from './market/MarketOverview';
import { MarketSearch } from './market/MarketSearch';
import { OrderBookTable } from './market/OrderBookTable';
import { PriceChart } from './market/PriceChart';
import { RegionCompareTable } from './market/RegionCompareTable';
import { RegionSelect } from './market/RegionSelect';
import { WatchlistPanel } from './market/WatchlistPanel';

type MarketTab = 'book' | 'analytics' | 'watchlist';

type SelectedType = { typeId: number; name: string };

type Props = { onMenu: () => void; csrfToken: string };

const AUTO_REFRESH_MS = 60_000;

/** Главный экран маркета: сводка, ордер-бук, аналитика, вотчлист и алерты. */
export function MarketScreen({ onMenu, csrfToken }: Props) {
  const { t } = useI18n();
  const [regions, setRegions] = useState<MarketRegion[]>([]);
  const [regionId, setRegionId] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<MarketSnapshotMeta | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<SelectedType | null>(null);
  const [overview, setOverview] = useState<MarketOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<MarketTab>('book');
  const overviewGeneration = useRef(0);

  const loadSnapshot = useCallback(async () => {
    const payload = await webApi.market.status();
    setSnapshot(payload.snapshot);
    setLastUpdatedAt(new Date());
  }, []);

  const loadOverview = useCallback(async (typeId: number, region: number) => {
    const current = ++overviewGeneration.current;
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const payload = await webApi.market.overview(typeId, region);
      if (current !== overviewGeneration.current) return;
      setOverview(payload.overview);
    } catch (reason) {
      if (current !== overviewGeneration.current) return;
      setOverview(null);
      setOverviewError(reason instanceof Error ? reason.message : t('requestFailed'));
    } finally {
      if (current === overviewGeneration.current) setOverviewLoading(false);
    }
  }, [t]);

  // Первичная загрузка: торговые регионы + свежесть снапшота. Дефолт —
  // regions[0]: loadTradeRegions сортирует по размеру, первый — The Forge.
  const boot = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    try {
      const [regionsPayload] = await Promise.all([webApi.market.regions(), loadSnapshot()]);
      setRegions(regionsPayload.regions);
      setRegionId((current) => current ?? regionsPayload.regions[0]?.region_id ?? null);
    } catch (reason) {
      setBootError(reason instanceof Error ? reason.message : t('requestFailed'));
    } finally {
      setBooting(false);
    }
  }, [loadSnapshot, t]);

  useEffect(() => { void boot(); }, [boot]);

  const selectType = useCallback((typeId: number, name: string) => {
    setSelectedType({ typeId, name });
    setActiveTab('book');
  }, []);

  // Сводка перезагружается при смене товара или региона.
  const selectedTypeId = selectedType?.typeId ?? null;
  useEffect(() => {
    if (selectedTypeId === null) {
      overviewGeneration.current += 1;
      setOverview(null);
      setOverviewError(null);
      setOverviewLoading(false);
      return;
    }
    if (regionId === null) return;
    void loadOverview(selectedTypeId, regionId);
  }, [selectedTypeId, regionId, loadOverview]);

  // Auto-refresh: каждые 60 с, только пока вкладка видима, — свежесть
  // снапшота + сводка выбранного товара; на hidden интервал простаивает.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void loadSnapshot().catch(() => undefined);
      if (selectedTypeId !== null && regionId !== null) void loadOverview(selectedTypeId, regionId);
    };
    const timer = window.setInterval(refresh, AUTO_REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [selectedTypeId, regionId, loadOverview, loadSnapshot]);

  const tabs: Array<{ id: MarketTab; label: string }> = [
    { id: 'book', label: t('marketTabBook') },
    { id: 'analytics', label: t('marketTabAnalytics') },
    { id: 'watchlist', label: t('marketTabWatchlist') },
  ];

  return (
    <section className="workspace-screen">
      <header className="workspace-header">
        <button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon /></button>
        <div><span className="workspace-kicker">ESI · MARKET</span><h1>{t('market')}</h1><p>{t('marketLead')}</p></div>
        <LocaleSwitch />
      </header>
      <div className="workspace-scroll">
        {booting ? <div className="panel-loading">{t('loading')}…</div> : null}
        {bootError ? (
          <div className="workspace-error" role="alert">
            {bootError}
            <button type="button" onClick={() => void boot()}>{t('retry')}</button>
          </div>
        ) : null}
        {!booting && !bootError ? (
          <>
            <div className="market-toolbar">
              <RegionSelect regions={regions} value={regionId} onChange={setRegionId} />
              <MarketSearch onSelect={selectType} />
            </div>
            <div className="market-layout">
              <MarketGroupsTree onSelect={selectType} selectedTypeId={selectedTypeId} />
              <div className="market-content">
                {selectedType ? (
                  <>
                    <header className="market-hero">
                      <h2>{selectedType.name}</h2>
                      {overview?.group_name ? <p>{overview.group_name}</p> : null}
                    </header>
                    {overviewLoading && !overview ? <div className="panel-loading">{t('loading')}…</div> : null}
                    {overviewError ? (
                      <div className="workspace-error" role="alert">
                        {overviewError}
                        <button
                          type="button"
                          onClick={() => { if (regionId !== null) void loadOverview(selectedType.typeId, regionId); }}
                        >
                          {t('retry')}
                        </button>
                      </div>
                    ) : null}
                    {overview ? (
                      <MarketOverviewPanel overview={overview} snapshot={snapshot} lastUpdatedAt={lastUpdatedAt} />
                    ) : null}
                  </>
                ) : null}
                <div className="market-tabs" role="tablist" aria-label={t('market')}>
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === tab.id}
                      className={`market-tabs__tab${activeTab === tab.id ? ' market-tabs__tab--active' : ''}`}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                {!selectedType && activeTab !== 'watchlist' ? (
                  <div className="workspace-empty">
                    <MarketIcon size={38} />
                    <h2>{t('marketSelectItem')}</h2>
                  </div>
                ) : null}
                {selectedType && activeTab === 'book' && regionId !== null ? (
                  <OrderBookTable typeId={selectedType.typeId} regionId={regionId} />
                ) : null}
                {selectedType && activeTab === 'analytics' && regionId !== null ? (
                  <>
                    <PriceChart typeId={selectedType.typeId} regionId={regionId} />
                    <RegionCompareTable typeId={selectedType.typeId} selectedRegionId={regionId} />
                  </>
                ) : null}
                {activeTab === 'watchlist' ? (
                  <>
                    <WatchlistPanel
                      selectedType={selectedType}
                      regionId={regionId}
                      csrfToken={csrfToken}
                      onSelect={selectType}
                    />
                    <AlertsPanel
                      selectedType={selectedType}
                      regionId={regionId}
                      csrfToken={csrfToken}
                      bestSell={overview?.best_sell ?? null}
                      bestBuy={overview?.best_buy ?? null}
                    />
                  </>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
