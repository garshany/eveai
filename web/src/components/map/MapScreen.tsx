/**
 * Экран «Периметр».
 *
 * Слева — карта во весь экран, справа — тред агента. Экран отвечает за
 * состояние: какой пузырь показан, какая раскладка, что выбрано, куда строится
 * маршрут, и честно ли подписаны слои.
 *
 * Три режима деградации, и ни один из них не пустой экран:
 *   • граф не собран — объяснение и что должен сделать оператор;
 *   • нет персонажа или скоупа на позицию — публичная карта и что именно нужно;
 *   • всё есть — живой режим.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { webApi } from '../../api';
import { LocaleSwitch, useI18n } from '../../i18n';
import { MenuIcon } from '../../icons';
import type {
  InspectedSystem,
  MapBubble,
  MapKillEvent,
  MapRouteResponse,
  MapStatus,
  UniverseActivity,
  UniverseStatic,
  UniverseWormholes,
} from '../../types';
import { MapCanvas } from './MapCanvas';
import { PerimeterChat } from './PerimeterChat';
import { SystemInspector } from './SystemInspector';
import { bandLabelKey, freshnessKey, layerLabelKey } from './labels';
import { buildLayout, interpolateLayouts, type Layout, type LayoutMode } from './layout';
import { UniverseCanvas } from './UniverseCanvas';
import type { KillFlash } from './renderer';
import { hiddenHopCount } from './route-view';
import { useMapLive } from './use-map-live';

type Props = {
  csrfToken: string;
  onMenu: () => void;
};

const MORPH_MS = 700;
/** Публичный вид для гостя: Jita — самая узнаваемая точка Нового Эдема. */
const FALLBACK_SYSTEM_ID = 30000142;

export function MapScreen({ csrfToken, onMenu }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<MapStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [staticBubble, setStaticBubble] = useState<MapBubble | null>(null);
  const [radius, setRadius] = useState<number | null>(null);
  const [mode, setMode] = useState<LayoutMode>('ego');
  // 'universe' is a third view rather than a third layout: it draws the whole
  // cluster from shared static geometry instead of the pilot-relative bubble.
  const [universeView, setUniverseView] = useState(false);
  const [universe, setUniverse] = useState<UniverseStatic | null>(null);
  const [universeIntel, setUniverseIntel] = useState<UniverseActivity | null>(null);
  const [wormholes, setWormholes] = useState<UniverseWormholes | null>(null);
  const [showTraffic, setShowTraffic] = useState(false);
  const [showCamps, setShowCamps] = useState(true);
  const [showWormholes, setShowWormholes] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [route, setRoute] = useState<MapRouteResponse | null>(null);
  const [avoid, setAvoid] = useState<number[]>([]);
  const [flashes, setFlashes] = useState<KillFlash[]>([]);

  const liveEnabled = status?.character?.hasLocationScope === true && status.graph.ready;
  const live = useMapLive(liveEnabled === true, radius);

  // Живой пузырь всегда побеждает статический: поток свежее любого снимка.
  const bubble = live.bubble ?? staticBubble;

  // --- Статус --------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await webApi.map.status();
        if (cancelled) return;
        setStatus(payload);
        setRadius((current) => current ?? payload.limits.defaultRadius);
      } catch (error) {
        if (!cancelled) setStatusError(error instanceof Error ? error.message : t('requestFailed'));
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  // --- Статический снимок для гостя и для первого кадра ---------------------
  useEffect(() => {
    if (!status?.graph.ready || radius === null) return;
    if (liveEnabled && live.bubble) return;
    let cancelled = false;
    void (async () => {
      try {
        const payload = await webApi.map.bubble(
          liveEnabled ? undefined : FALLBACK_SYSTEM_ID,
          radius,
        );
        if (!cancelled) setStaticBubble(payload.bubble);
      } catch {
        // Живой поток может успеть раньше: молчаливый провал снимка не должен
        // затирать уже показанную карту.
        if (!cancelled && !live.bubble) {
          try {
            const fallback = await webApi.map.bubble(FALLBACK_SYSTEM_ID, radius);
            if (!cancelled) setStaticBubble(fallback.bubble);
          } catch {
            if (!cancelled) setStaticBubble(null);
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [status, radius, liveEnabled, live.bubble]);

  // --- Морф между раскладками ----------------------------------------------
  const targetLayout = useMemo<Layout>(
    () => (bubble ? buildLayout(bubble, mode) : new Map()),
    [bubble, mode],
  );
  const [layout, setLayout] = useState<Layout>(new Map());

  /**
   * The line on screen follows the server's active route, not just the one this
   * screen planned. The agent can reroute from the chat — it publishes the same
   * route it describes and sets in the autopilot — and the map has to agree.
   */
  const drawnRouteSystemIds = live.route?.systemIds ?? route?.route.systemIds ?? [];

  // How much of that route the bubble physically cannot place. The bubble is
  // radius-limited and a route is not, so this is the normal case, not an edge
  // one — and a silently shortened line reads as a shorter route.
  const hiddenJumps = useMemo(() => {
    if (drawnRouteSystemIds.length < 2 || !bubble) return 0;
    const inBubble = new Set(bubble.systems.map((system) => system.systemId));
    return hiddenHopCount(drawnRouteSystemIds, (id) => inBubble.has(id));
  }, [drawnRouteSystemIds, bubble]);

  // Static geometry is fetched once and kept; the live overlay refreshes on the
  // same cadence as the bubble intel and is shared server-side across viewers.
  useEffect(() => {
    if (!universeView || universe) return;
    let cancelled = false;
    void webApi.map.universe()
      .then((payload) => { if (!cancelled) setUniverse(payload); })
      .catch(() => { if (!cancelled) setUniverse(null); });
    return () => { cancelled = true; };
  }, [universeView, universe]);

  useEffect(() => {
    if (!universeView) return;
    let cancelled = false;
    const pull = (): void => {
      void webApi.map.universeIntel()
        .then((payload) => { if (!cancelled) setUniverseIntel(payload); })
        .catch(() => undefined);
    };
    pull();
    const timer = setInterval(pull, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [universeView]);

  // EVE-Scout exits. Polled far more slowly than the kill rollup because the
  // upstream itself is cached for five minutes — asking faster would only
  // re-fetch the same answer.
  useEffect(() => {
    if (!universeView) return;
    let cancelled = false;
    const pull = (): void => {
      void webApi.map.universeWormholes()
        .then((payload) => { if (!cancelled) setWormholes(payload); })
        .catch(() => undefined);
    };
    pull();
    const timer = setInterval(pull, 120_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [universeView]);
  // Текущая раскладка держится ещё и в ref: эффект морфа читает точку старта,
  // но не должен перезапускаться от собственных промежуточных кадров.
  const layoutRef = useRef<Layout>(layout);
  layoutRef.current = layout;
  const morphRef = useRef<{ from: Layout; startedAt: number } | null>(null);

  useEffect(() => {
    const from = layoutRef.current;
    // Первый кадр не анимируется: карта должна появиться сразу.
    if (from.size === 0) {
      setLayout(targetLayout);
      return;
    }
    morphRef.current = { from, startedAt: Date.now() };
    let frame = 0;
    const step = (): void => {
      const morph = morphRef.current;
      if (!morph) return;
      const progress = (Date.now() - morph.startedAt) / MORPH_MS;
      if (progress >= 1) {
        setLayout(targetLayout);
        morphRef.current = null;
        return;
      }
      setLayout(interpolateLayouts(morph.from, targetLayout, progress));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [targetLayout]);

  // --- Вспышки килов --------------------------------------------------------
  // Очередь потока накопительная, поэтому берём только то, чего ещё не видели:
  // иначе каждый новый кил заново поджигал десяток старых.
  const flashedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (live.killEvents.length === 0) return;
    const fresh = live.killEvents.filter((kill) => !flashedRef.current.has(kill.killmailId));
    if (fresh.length === 0) return;
    for (const kill of fresh) flashedRef.current.add(kill.killmailId);
    if (flashedRef.current.size > 500) {
      flashedRef.current = new Set([...flashedRef.current].slice(-250));
    }
    const now = Date.now();
    setFlashes((previous) => [
      ...previous.filter((flash) => now - flash.startedAt < 2000),
      ...fresh.slice(-10).map((kill) => ({
        systemId: kill.systemId,
        startedAt: now,
        value: kill.totalValue,
      })),
    ]);
  }, [live.killEvents]);

  const pilotSystemId = live.location?.solarSystemId ?? bubble?.originId ?? null;

  const bubbleSelection = useMemo<InspectedSystem | null>(
    () => bubble?.systems.find((system) => system.systemId === selected) ?? null,
    [bubble, selected],
  );

  /**
   * The inspector opens from either map, and the whole-cluster map can select
   * any of the ~8490 systems — almost none of which are in the pilot's bubble.
   * Looking the selection up only in the bubble is why clicking a nullsec system
   * on the full map used to draw a selection ring and then say nothing at all.
   *
   * A system inside the bubble opens instantly from data already on screen and
   * is then replaced by the server's rollup; anything else waits for that one
   * request. Kills are fetched here rather than inside the panel so an
   * out-of-bubble system costs one round trip instead of two.
   */
  const [inspected, setInspected] = useState<InspectedSystem | null>(null);
  const [inspectedKills, setInspectedKills] = useState<MapKillEvent[] | null>(null);
  // A failed lookup must say so. Silence here is indistinguishable from the bug
  // this replaced: the system lights up and nothing ever opens.
  const [inspectError, setInspectError] = useState<string | null>(null);
  // Read through a ref: the live bubble is a new object every few seconds, and
  // depending on it directly would refetch the panel on every frame.
  const seedRef = useRef<{ system: InspectedSystem | null; pilot: number | null }>(
    { system: null, pilot: null },
  );
  seedRef.current = { system: bubbleSelection, pilot: pilotSystemId };

  useEffect(() => {
    if (selected === null) {
      setInspected(null);
      setInspectedKills(null);
      setInspectError(null);
      return;
    }
    setInspected(seedRef.current.system);
    setInspectedKills(null);
    setInspectError(null);
    let cancelled = false;
    void webApi.map.system(selected, seedRef.current.pilot)
      .then((payload) => {
        if (cancelled) return;
        setInspected(payload.system);
        setInspectedKills(payload.kills);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setInspectedKills([]);
        setInspectError(error instanceof Error ? error.message : t('requestFailed'));
      });
    return () => { cancelled = true; };
  }, [selected, t]);

  const focusSystem = useCallback((systemId: number) => {
    setSelected(systemId);
    setFollow(false);
  }, []);

  const clearDrawnRoute = useCallback(async () => {
    setRoute(null);
    try {
      await webApi.map.clearRoute(csrfToken);
    } catch {
      // The line the server holds stays until it answers; nothing local to undo.
    }
  }, [csrfToken]);

  const planRoute = useCallback(async (destination: number) => {
    if (!bubble) return;
    try {
      const payload = await webApi.map.route({
        // Where the pilot actually is, not where the bubble happens to be
        // centred — on the full map those differ, and for a guest the bubble is
        // centred on Jita.
        origin: pilotSystemId ?? bubble.originId,
        destination,
        mode: 'shortest',
        // Ненулевой вес по умолчанию: экран называется «безопасный маршрут»,
        // и кратчайший путь здесь — это осознанный выбор, а не умолчание.
        risk: 4,
        avoid,
        useWormholes: false,
      }, csrfToken);
      setRoute(payload);
    } catch {
      setRoute(null);
    }
  }, [bubble, avoid, csrfToken, pilotSystemId]);

  // --- Состояния отказа -----------------------------------------------------
  if (statusError) {
    return <MapShell onMenu={onMenu} title={t('perimeter')}>
      <p className="perimeter-notice" role="alert">{statusError}</p>
    </MapShell>;
  }
  if (!status) {
    return <MapShell onMenu={onMenu} title={t('perimeter')}>
      <p className="perimeter-notice">{t('loading')}</p>
    </MapShell>;
  }
  if (!status.graph.ready) {
    return <MapShell onMenu={onMenu} title={t('perimeter')}>
      <p className="perimeter-notice" role="alert">{status.graph.reason}</p>
    </MapShell>;
  }

  const missingScope = status.character && !status.character.hasLocationScope;

  return <MapShell onMenu={onMenu} title={t('perimeter')}>
    <div className="perimeter">
      <div className="perimeter__stage">
        {universeView
          ? (universe
            ? <UniverseCanvas
              universe={universe}
              activity={universeIntel}
              currentSystemId={live.location?.solarSystemId ?? null}
              routeSystemIds={drawnRouteSystemIds}
              avoidedSystemIds={avoid}
              wormholes={showWormholes ? wormholes?.links ?? [] : []}
              showTraffic={showTraffic}
              showCamps={showCamps}
              selectedSystemId={selected}
              onSelect={setSelected}
            />
            : <p className="perimeter-notice">{t('loading')}</p>)
          : bubble
          ? <MapCanvas
            bubble={bubble}
            layout={layout}
            pilotSystemId={live.location?.solarSystemId ?? (liveEnabled ? null : bubble.originId)}
            pilotOnline={live.location?.online ?? false}
            selectedSystemId={selected}
            routeSystemIds={drawnRouteSystemIds}
            flashes={flashes}
            jumpCounter={live.jumpCounter}
            follow={follow}
            onFollowChange={setFollow}
            onSelect={setSelected}
          />
          : <p className="perimeter-notice">{t('loading')}</p>}

        <div className="perimeter__hud">
          <div className="perimeter__hud-row">
            <button
              type="button"
              className={`perimeter-chip${mode === 'ego' ? ' perimeter-chip--active' : ''}`}
              onClick={() => setMode('ego')}
            >{t('perimeterLayoutEgo')}</button>
            <button
              type="button"
              className={`perimeter-chip${mode === 'geo' ? ' perimeter-chip--active' : ''}`}
              onClick={() => setMode('geo')}
            >{t('perimeterLayoutGeo')}</button>
            <button
              type="button"
              className={`perimeter-chip${universeView ? ' perimeter-chip--active' : ''}`}
              onClick={() => setUniverseView((value) => !value)}
            >{t('perimeterLayoutUniverse')}</button>
            {liveEnabled && !universeView ? <button
              type="button"
              className={`perimeter-chip${follow ? ' perimeter-chip--active' : ''}`}
              onClick={() => setFollow((value) => !value)}
            >{t('perimeterFollow')}</button> : null}
          </div>

          {universeView ? <div className="perimeter__hud-row">
            <button
              type="button"
              className={`perimeter-chip${showCamps ? ' perimeter-chip--active' : ''}`}
              onClick={() => setShowCamps((value) => !value)}
            >{t('perimeterLayerCamps')}</button>
            <button
              type="button"
              className={`perimeter-chip${showTraffic ? ' perimeter-chip--active' : ''}`}
              onClick={() => setShowTraffic((value) => !value)}
            >{t('perimeterLayerTraffic')}</button>
            <button
              type="button"
              className={`perimeter-chip${showWormholes ? ' perimeter-chip--active' : ''}`}
              onClick={() => setShowWormholes((value) => !value)}
            >{t('perimeterLayerWormholes')}</button>
          </div> : null}

          {/* Пузырь ограничен радиусом, маршрут — нет. Молча обрезать линию
              значит показать более короткий маршрут, чем назвал лоцман. */}
          {!universeView && hiddenJumps > 0 ? <div className="perimeter__hud-row">
            <span className="perimeter-fresh perimeter-fresh--hourly">
              {t('perimeterRouteBeyond', { jumps: String(hiddenJumps) })}
            </span>
            <button
              type="button"
              className="perimeter-chip"
              onClick={() => setUniverseView(true)}
            >{t('perimeterRouteOpenUniverse')}</button>
          </div> : null}

          {universeView ? null : <label className="perimeter__radius">
            {t('perimeterRadius', { jumps: String(radius ?? status.limits.defaultRadius) })}
            <input
              type="range"
              min={1}
              max={status.limits.maxRadius}
              value={radius ?? status.limits.defaultRadius}
              onChange={(event) => setRadius(Number(event.target.value))}
            />
          </label>}

          <MapLegend bubble={universeView ? null : bubble} universe={universeView ? universeIntel : null} />
        </div>

        {/* Честность слоёв — часть продукта, а не подпись мелким шрифтом. */}
        {bubble ? <div className="perimeter__freshness">
          {bubble.freshness.map((layerInfo) => <span
            key={layerInfo.layer}
            className={`perimeter-fresh perimeter-fresh--${layerInfo.status}`}
            title={layerInfo.error ?? undefined}
          >
            {layerLabelKey(layerInfo.layer) ? t(layerLabelKey(layerInfo.layer)!) : layerInfo.layer}
            {': '}
            {t(freshnessKey(layerInfo.status))}
          </span>)}
          {bubble.truncated ? <span className="perimeter-fresh perimeter-fresh--hourly">
            {t('perimeterTruncated', { shown: String(bubble.radius), asked: String(bubble.requestedRadius) })}
          </span> : null}
        </div> : null}

        {missingScope ? <p className="perimeter-notice perimeter-notice--inline">
          {t('perimeterMissingScope', { scope: status.character?.missingScope ?? '' })}
        </p> : null}
        {!status.character ? <p className="perimeter-notice perimeter-notice--inline">
          {t('perimeterGuest')}
        </p> : null}
        {live.warning ? <p className="perimeter-notice perimeter-notice--inline" role="status">
          {live.warning}
          <button type="button" className="perimeter-chip" onClick={live.reconnect}>{t('retry')}</button>
        </p> : null}
        {live.status === 'offline' ? <p className="perimeter-notice perimeter-notice--inline">
          {t('perimeterPilotOffline')}
        </p> : null}

        {inspected === null && inspectError !== null ? <p
          className="perimeter-notice perimeter-notice--inline"
          role="alert"
        >{inspectError}</p> : null}

        {inspected ? <SystemInspector
          system={inspected}
          kills={inspectedKills}
          onClose={() => setSelected(null)}
          onRouteTo={(systemId) => void planRoute(systemId)}
          onAvoid={(systemId) => setAvoid((previous) => (
            previous.includes(systemId) ? previous : [...previous, systemId]
          ))}
          onAsk={focusSystem}
        /> : null}

        {route?.route.ok
          ? <RouteRibbon route={route} onClear={() => void clearDrawnRoute()} />
          : live.route
          // A route the agent planned carries only its system ids, so it gets a
          // compact banner rather than the per-system ribbon. Without it there
          // was no jump count and no way to take the line off the map at all.
          ? <div className="perimeter__route">
            <div className="perimeter__route-head">
              <strong>{t('perimeterRouteAgent', {
                jumps: String(live.route.jumps),
                mode: live.route.mode,
              })}</strong>
              <button
                type="button"
                className="perimeter-chip"
                onClick={() => void clearDrawnRoute()}
              >{t('perimeterRouteClear')}</button>
            </div>
          </div>
          : null}
      </div>

      <PerimeterChat
        csrfToken={csrfToken}
        advisories={live.advisories}
        context={{
          systemId: live.location?.solarSystemId ?? bubble?.originId ?? null,
          selectedSystemId: selected,
          shipTypeId: live.location?.shipTypeId ?? null,
          radius,
          band: bubble?.verdict.band ?? null,
        }}
        onFocusSystem={focusSystem}
      />
    </div>
  </MapShell>;
}

function MapShell({
  onMenu,
  title,
  children,
}: {
  onMenu: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  // Тот же каркас, что у маркета и профиля, но без workspace-scroll: холст
  // занимает всю высоту сам и прокручивается зумом, а не полосой.
  return <section className="workspace-screen workspace-screen--map">
    <header className="workspace-header">
      <button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}>
        <MenuIcon />
      </button>
      <div>
        <span className="workspace-kicker">ESI · EVE-KILL · SDE</span>
        <h1>{title}</h1>
        <p>{t('perimeterLead')}</p>
      </div>
      <LocaleSwitch />
    </header>
    {children}
  </section>;
}

/**
 * Always visible, never behind a hover or an onboarding tour: a legend the
 * pilot has to go looking for is a legend nobody reads. Each row names one
 * visual channel, and there are deliberately few of them — every extra channel
 * is one more thing competing for the same glyph.
 */
function MapLegend({ bubble, universe }: { bubble: MapBubble | null; universe: UniverseActivity | null }) {
  const { t } = useI18n();
  return <div className="perimeter__legend">
    {bubble ? <>
      <span>{t('perimeterVerdict')}: {t(bandLabelKey(bubble.verdict.band))}</span>
      <span>{t('perimeterSystems', { count: String(bubble.systems.length) })}</span>
    </> : null}
    {universe ? <span>{t('perimeterUniverseTotals', {
      systems: String(universe.totals.activeSystems),
      kills: String(universe.totals.kills1h),
      camps: String(universe.totals.campedSystems),
    })}</span> : null}
    <ul className="perimeter__legend-keys">
      <li><i className="legend-dot legend-dot--sec" />{t('perimeterKeySecurity')}</li>
      <li><i className="legend-ring" />{t('perimeterKeyThreat')}</li>
      <li><i className="legend-dot legend-dot--big" />{t('perimeterKeyTraffic')}</li>
      <li><span className="legend-glyph">☠</span>{t('perimeterKeyCamp')}</li>
      <li><i className="legend-cross" />{t('perimeterKeyAvoided')}</li>
      {universe ? <li><i className="legend-dash" />{t('perimeterKeyWormhole')}</li> : null}
    </ul>
  </div>;
}

function RouteRibbon({ route, onClear }: { route: MapRouteResponse; onClear: () => void }) {
  const { t } = useI18n();
  const coverage = route.dangerCoverage;
  return <div className="perimeter__route">
    <div className="perimeter__route-head">
      <strong>{t('perimeterRouteJumps', { jumps: String(route.route.jumps) })}</strong>
      <button type="button" className="perimeter-chip" onClick={onClear}>{t('cancel')}</button>
    </div>
    {/* Покрытие говорит, по скольким прыжкам вообще была информация: маршрут
        без этого числа выглядит увереннее, чем он есть. */}
    <p className="perimeter__route-coverage">
      {t('perimeterRouteCoverage', {
        known: String(coverage.knownSystems),
        total: String(coverage.totalSystems),
      })}
    </p>
    <ol className="perimeter__route-list">
      {route.systems.map((system) => <li key={system.systemId}>
        <span>{system.name}</span>
        <span>{system.security.toFixed(1)}</span>
        <span>{system.danger === null ? '—' : `${Math.round(system.danger * 100)}%`}</span>
      </li>)}
    </ol>
  </div>;
}
