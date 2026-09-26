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
import { bandLabelKey, freshnessKey, freshnessLayersForView, layerLabelKey } from './labels';
import { buildLayout, interpolateLayouts, layoutsEqual, type Layout, type LayoutMode } from './layout';
import { UniverseCanvas } from './UniverseCanvas';
import type { KillFlash } from './renderer';
import { mergeSystemKills, overlayLiveKills, unseenKills, type ReceivedKill } from './live-merge';
import { hiddenHopCount } from './route-view';
import { useMapLive } from './use-map-live';
import { securityClassName } from '../../security';

type Props = {
  csrfToken: string;
  onMenu: () => void;
};

const MORPH_MS = 700;
/**
 * How often a map without a live stream (guest, no location scope) re-reads
 * its bubble. Matches the server's default intel cadence: faster only re-reads
 * the same rollup, slower lets kills go unseen for minutes.
 */
const STATIC_REFRESH_MS = 15_000;
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
  const [universeIntel, setUniverseIntel] = useState<{ payload: UniverseActivity; receivedAtMs: number } | null>(null);
  // Live-stream kills with their receipt time, laid over the polled cluster
  // rollup so the whole-map view does not wait up to a poll for news.
  const [liveKillLog, setLiveKillLog] = useState<ReceivedKill[]>([]);
  const [wormholes, setWormholes] = useState<UniverseWormholes | null>(null);
  const [showTraffic, setShowTraffic] = useState(false);
  const [showCamps, setShowCamps] = useState(true);
  const [showWormholes, setShowWormholes] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [legendOpen, setLegendOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [route, setRoute] = useState<MapRouteResponse | null>(null);
  const [avoid, setAvoid] = useState<number[]>([]);
  const [flashes, setFlashes] = useState<KillFlash[]>([]);
  // A request to bring a system into view (an advisory anchor). A new object
  // each time, so asking twice for the same system still moves the camera.
  const [focus, setFocus] = useState<{ systemId: number } | null>(null);

  const liveEnabled = status?.character?.hasLocationScope === true && status.graph.ready;
  const live = useMapLive(liveEnabled === true, radius, csrfToken);

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
    const pull = async (): Promise<void> => {
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
    };
    void pull();
    // With a live stream the snapshot is only the first frame. Without one it
    // is the whole radar, and a one-shot fetch froze it at page load: kills
    // never appeared for a guest however long the tab stayed open. Paused
    // while the tab is hidden, and caught up the moment it is visible again.
    if (liveEnabled) return () => { cancelled = true; };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void pull();
    }, STATIC_REFRESH_MS);
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') void pull();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [status, radius, liveEnabled, live.bubble]);

  // --- Морф между раскладками ----------------------------------------------
  // Every live tick delivers a new bubble object. Keep the previous target when
  // the geometry is identical so the morph effect below only runs when the
  // layout actually changes, not on every intel refresh.
  const stableTargetRef = useRef<Layout>(new Map());
  const targetLayout = useMemo<Layout>(() => {
    const next: Layout = bubble ? buildLayout(bubble, mode) : new Map();
    if (layoutsEqual(next, stableTargetRef.current)) return stableTargetRef.current;
    stableTargetRef.current = next;
    return next;
  }, [bubble, mode]);
  const [layout, setLayout] = useState<Layout>(new Map());

  /**
   * The line on screen follows the server's active route, not just the one this
   * screen planned. The agent can reroute from the chat — it publishes the same
   * route it describes and sets in the autopilot — and the map has to agree.
   */
  // Once the stream has spoken, it is the authority — including when it says
  // there is no route. Falling through to the last route this tab planned made
  // expiry and clearing cosmetic: the server dropped the route, the client
  // redrew it from stale local state, and a two-hour-old line came back looking
  // authoritative. The local route is only a stand-in until the stream answers
  // (a guest, or no location scope, never gets one).
  const drawnRouteSystemIds = live.routeKnown
    ? live.route?.systemIds ?? []
    : route?.route.systemIds ?? [];

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
        .then((payload) => { if (!cancelled) setUniverseIntel({ payload, receivedAtMs: Date.now() }); })
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
    // Already there: nothing to animate.
    if (layoutsEqual(from, targetLayout)) {
      morphRef.current = null;
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
        // A kill streamed while this request was in flight may be newer than
        // the index the server answered from.
        setInspectedKills(mergeSystemKills(payload.kills, liveKillsRef.current, selected));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setInspectedKills([]);
        setInspectError(error instanceof Error ? error.message : t('requestFailed'));
      });
    return () => { cancelled = true; };
  }, [selected, t]);

  // --- Вспышки килов --------------------------------------------------------
  // Очередь потока накопительная, поэтому берём только то, чего ещё не видели:
  // иначе каждый новый кил заново поджигал десяток старых.
  const flashedRef = useRef<Set<number>>(new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const liveKillsRef = useRef(live.killEvents);
  liveKillsRef.current = live.killEvents;

  /**
   * A kill the screen has not shown yet: flash it (unless it is part of the
   * first snapshot of a bubble, which is history rather than news) and, if its
   * system is open in the inspector, put it at the top of that list at once —
   * the radar must not show a fresh kill on the map while the panel about that
   * very system still says nothing happened.
   */
  const announceKills = useCallback((fresh: MapKillEvent[], flash: boolean) => {
    for (const kill of fresh) flashedRef.current.add(kill.killmailId);
    if (flashedRef.current.size > 500) {
      flashedRef.current = new Set([...flashedRef.current].slice(-250));
    }
    if (flash) {
      const now = Date.now();
      setFlashes((previous) => [
        ...previous.filter((item) => now - item.startedAt < 2000),
        ...fresh.slice(-10).map((kill) => ({
          systemId: kill.systemId,
          startedAt: now,
          value: kill.totalValue,
        })),
      ]);
    }
    const open = selectedRef.current;
    if (open !== null) {
      setInspectedKills((previous) => (previous === null ? previous : mergeSystemKills(previous, fresh, open)));
    }
  }, []);

  useEffect(() => {
    if (live.killEvents.length === 0) return;
    const fresh = unseenKills(live.killEvents, flashedRef.current);
    if (fresh.length === 0) return;
    announceKills(fresh, true);
    const receivedAtMs = Date.now();
    setLiveKillLog((previous) => [
      ...previous,
      ...fresh.map((kill) => ({ kill, receivedAtMs })),
    ].slice(-200));
  }, [live.killEvents, announceKills]);

  const universeActivity = useMemo(
    () => (universeIntel
      ? overlayLiveKills(universeIntel.payload, liveKillLog, universeIntel.receivedAtMs)
      : null),
    [universeIntel, liveKillLog],
  );
  const freshnessLayers = freshnessLayersForView(
    bubble?.freshness ?? null,
    universeIntel?.payload.killFeed ?? null,
    universeView,
  );

  // Without a stream the only news is what a refreshed snapshot carries.
  const staticPrimedRef = useRef<string | null>(null);
  useEffect(() => {
    if (liveEnabled || !staticBubble) return;
    const key = `${staticBubble.originId}:${staticBubble.radius}`;
    const primed = staticPrimedRef.current === key;
    staticPrimedRef.current = key;
    const fresh = unseenKills(staticBubble.recentKills, flashedRef.current);
    if (fresh.length > 0) announceKills(fresh, primed);
  }, [staticBubble, liveEnabled, announceKills]);

  const focusSystem = useCallback((systemId: number) => {
    setSelected(systemId);
    setFollow(false);
    setFocus({ systemId });
  }, []);

  // «На меня»: живой пилот — включаем следование; последняя известная позиция
  // — просто везём камеру к ней. Раньше центрироваться можно было только при
  // живом потоке, и без него свой корабль приходилось искать глазами.
  const centreOnPilot = useCallback((systemId: number | null) => {
    if (systemId === null) return;
    setUniverseView(false);
    if (liveEnabled && live.location?.online) {
      setFollow(true);
      setFocus(null);
    } else {
      setFollow(false);
      setFocus({ systemId });
    }
  }, [liveEnabled, live.location?.online]);

  // The rings and geography chips used to change only the bubble layout, so
  // with the whole map open they lit up and did nothing: the pilot was stuck
  // in the universe view until they found the toggle again. A pending camera
  // request belongs to the view it was made in.
  const showLayout = useCallback((next: LayoutMode) => {
    setMode(next);
    setUniverseView(false);
    setFocus(null);
  }, []);
  const showUniverse = useCallback((next: boolean) => {
    setUniverseView(next);
    setFocus(null);
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
  // Без живого потока центр пузыря — последняя известная позиция (или Jita
  // у гостя): камера держится за неё так же, как за живого пилота.
  const pilotMarkerId = live.location?.solarSystemId ?? (liveEnabled ? null : bubble?.originId ?? null);
  const pilotLabel = status.character
    ? [status.character.characterName, bubble?.pilotShip?.shipName].filter(Boolean).join(' · ')
    : null;
  const showCentre = pilotMarkerId !== null && status.character !== null;
  // Почасовой слой (фон ESI, суверенитет) — это его нормальный ритм, а не
  // сбой: несвежими считаются только кэш и недоступные слои.
  const staleLayers = freshnessLayers?.filter((layerInfo) => (
    layerInfo.status === 'cached' || layerInfo.status === 'unavailable'
  )).length ?? 0;

  return <MapShell onMenu={onMenu} title={t('perimeter')}>
    <div className="perimeter">
      <div className="perimeter__stage">
        {universeView
          ? (universe
            ? <UniverseCanvas
              universe={universe}
              activity={universeActivity}
              flashes={flashes}
              currentSystemId={live.location?.solarSystemId ?? null}
              routeSystemIds={drawnRouteSystemIds}
              avoidedSystemIds={avoid}
              wormholes={showWormholes ? wormholes?.links ?? [] : []}
              showTraffic={showTraffic}
              showCamps={showCamps}
              selectedSystemId={selected}
              focus={focus}
              onSelect={setSelected}
            />
            : <p className="perimeter-notice">{t('loading')}</p>)
          : bubble
          ? <MapCanvas
            bubble={bubble}
            layout={layout}
            pilotSystemId={pilotMarkerId}
            pilotOnline={live.location?.online ?? false}
            pilotLabel={pilotLabel}
            selectedSystemId={selected}
            routeSystemIds={drawnRouteSystemIds}
            flashes={flashes}
            jumpCounter={live.jumpCounter}
            follow={follow}
            focus={focus}
            onFollowChange={setFollow}
            onSelect={setSelected}
          />
          : <p className="perimeter-notice">{t('loading')}</p>}

        {/* Верхняя панель: вид, радиус, вердикт. Одна строка вместо коробки
            с пятью разными элементами, которая закрывала треть карты. */}
        <div className="pmap-bar">
          <div className="pmap-seg" role="group" aria-label={t('perimeterViewLabel')}>
            <button
              type="button"
              aria-pressed={!universeView && mode === 'ego'}
              onClick={() => showLayout('ego')}
            >{t('perimeterLayoutEgo')}</button>
            <button
              type="button"
              aria-pressed={!universeView && mode === 'geo'}
              onClick={() => showLayout('geo')}
            >{t('perimeterLayoutGeo')}</button>
            <button
              type="button"
              aria-pressed={universeView}
              onClick={() => showUniverse(!universeView)}
            >{t('perimeterLayoutUniverse')}</button>
          </div>

          {universeView ? null : <label className="pmap-radius">
            <span>{t('perimeterRadius', { jumps: String(radius ?? status.limits.defaultRadius) })}</span>
            <input
              type="range"
              min={1}
              max={status.limits.maxRadius}
              value={radius ?? status.limits.defaultRadius}
              onChange={(event) => setRadius(Number(event.target.value))}
            />
          </label>}

          {universeView ? <div className="pmap-seg" role="group" aria-label={t('perimeterLayersLabel')}>
            <button type="button" aria-pressed={showCamps} onClick={() => setShowCamps((value) => !value)}>
              {t('perimeterLayerCamps')}
            </button>
            <button type="button" aria-pressed={showTraffic} onClick={() => setShowTraffic((value) => !value)}>
              {t('perimeterLayerTraffic')}
            </button>
            <button type="button" aria-pressed={showWormholes} onClick={() => setShowWormholes((value) => !value)}>
              {t('perimeterLayerWormholes')}
            </button>
          </div> : null}

          {!universeView && bubble ? <span className={`pmap-verdict pmap-verdict--${bubble.verdict.band}`}>
            {t(bandLabelKey(bubble.verdict.band))}
            <small>{t('perimeterSystems', { count: String(bubble.systems.length) })}</small>
          </span> : null}
          {universeView && universeActivity ? <span className="pmap-verdict">
            {t('perimeterUniverseTotals', {
              systems: String(universeActivity.totals.activeSystems),
              kills: String(universeActivity.totals.kills1h),
              camps: String(universeActivity.totals.campedSystems),
            })}
          </span> : null}
        </div>

        {/* Пузырь ограничен радиусом, маршрут — нет. Молча обрезать линию
            значит показать более короткий маршрут, чем назвал лоцман. */}
        {!universeView && hiddenJumps > 0 ? <div className="pmap-callout">
          <span>{t('perimeterRouteBeyond', { jumps: String(hiddenJumps) })}</span>
          <button type="button" onClick={() => showUniverse(true)}>{t('perimeterRouteOpenUniverse')}</button>
        </div> : null}

        {/* Живая лента: кто кого убил в пузыре за последний час. Клик — к системе. */}
        {!universeView && bubble ? <KillFeed
          kills={bubble.recentKills}
          systems={bubble.systems}
          onFocus={focusSystem}
        /> : null}

        {/* Управление камерой и справка — в углу, как в навигаторе. */}
        <div className="pmap-controls">
          {showCentre ? <button
            type="button"
            className="pmap-control"
            aria-pressed={liveEnabled && follow && !universeView}
            onClick={() => centreOnPilot(pilotMarkerId)}
            title={t('perimeterCentreOnMe')}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" /><path d="M10 1v4M10 15v4M1 10h4M15 10h4" /><circle cx="10" cy="10" r="6.5" fill="none" /></svg>
            <span>{t('perimeterCentreOnMe')}</span>
          </button> : null}
          <button
            type="button"
            className="pmap-control"
            aria-expanded={legendOpen}
            onClick={() => setLegendOpen((value) => !value)}
          >{t('perimeterLegend')}</button>
          {freshnessLayers ? <button
            type="button"
            className={`pmap-control pmap-control--data${staleLayers > 0 ? ' pmap-control--stale' : ''}`}
            aria-expanded={dataOpen}
            onClick={() => setDataOpen((value) => !value)}
          >
            <i aria-hidden="true" />
            {staleLayers > 0
              ? t('perimeterDataPartial', { count: String(staleLayers) })
              : t('perimeterDataLive')}
          </button> : null}

          {legendOpen ? <div className="pmap-pop">
            <MapLegend universe={universeView} />
          </div> : null}

          {/* Честность слоёв — часть продукта: свежесть каждого слоя по клику,
              а несвежий слой подсвечивает саму кнопку. */}
          {dataOpen && freshnessLayers ? <div className="pmap-pop">
            <ul className="pmap-fresh">
              {freshnessLayers.map((layerInfo) => <li
                key={layerInfo.layer}
                className={`pmap-fresh--${layerInfo.status}`}
                title={layerInfo.error ?? undefined}
              >
                <span>{layerLabelKey(layerInfo.layer) ? t(layerLabelKey(layerInfo.layer)!) : layerInfo.layer}</span>
                <b>{t(freshnessKey(layerInfo.status))}</b>
              </li>)}
              {/* An EVE-Scout outage renders as an empty layer, which reads as
                  "there are no exits anywhere in New Eden" — a lie people route by. */}
              {universeView && wormholes?.error ? <li className="pmap-fresh--unavailable">
                <span>{t('perimeterLayerWormholes')}</span><b>{t('perimeterFresh_unavailable')}</b>
              </li> : null}
            </ul>
            {bubble?.truncated ? <p>
              {t('perimeterTruncated', { shown: String(bubble.radius), asked: String(bubble.requestedRadius) })}
            </p> : null}
          </div> : null}
        </div>

        {/* One stack, so several notices never land on top of each other. */}
        <div className="perimeter-notices">
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
        </div>

        {/* Shown whether or not the panel opened. A system already in the bubble
            seeds the panel, so gating this on an empty panel hid the failure
            behind stale data and an empty kill list — the same "it lights up
            and says nothing" this screen was fixed to stop doing. */}
        {inspectError !== null ? <p
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

        {/* The stream saying "no route" outranks anything this tab remembers. */}
        {live.routeKnown && live.route === null
          ? null
          : route?.route.ok
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
  // Шапка — одна строка: карта и есть экран, трёхэтажный заголовок над ней
  // отнимал высоту у того, ради чего сюда пришли.
  return <section className="workspace-screen workspace-screen--map">
    <header className="pmap-head">
      <button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}>
        <MenuIcon />
      </button>
      <h1>{title}</h1>
      <p>{t('perimeterLead')}</p>
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
function MapLegend({ universe }: { universe: boolean }) {
  const { t } = useI18n();
  return <ul className="perimeter__legend-keys">
    <li><i className="legend-dot legend-dot--sec" />{t('perimeterKeySecurity')}</li>
    <li><i className="legend-ring" />{t('perimeterKeyThreat')}</li>
    <li><i className="legend-dot legend-dot--big" />{t('perimeterKeyTraffic')}</li>
    <li><span className="legend-glyph">☠</span>{t('perimeterKeyCamp')}</li>
    <li><i className="legend-ember" />{t('perimeterKeyKills')}</li>
    {universe ? null : <li><i className="legend-flow" />{t('perimeterKeyFlow')}</li>}
    <li><i className="legend-cross" />{t('perimeterKeyAvoided')}</li>
    {universe ? <li><i className="legend-dash" />{t('perimeterKeyWormhole')}</li> : null}
  </ul>;
}

const KILL_FEED_WINDOW_MS = 60 * 60_000;
const KILL_FEED_ROWS = 4;

/**
 * Лента киллов пузыря: «кто кого» последнего часа. Это ответ на «чувствую ли я,
 * что здесь происходит» — карта показывает где, лента показывает кто.
 */
function KillFeed({
  kills,
  systems,
  onFocus,
}: {
  kills: MapKillEvent[];
  systems: MapBubble['systems'];
  onFocus: (systemId: number) => void;
}) {
  const { t, locale } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const names = useMemo(() => new Map(systems.map((system) => [system.systemId, system])), [systems]);
  const rows = useMemo(() => kills
    .filter((kill) => !kill.isNpc && now - kill.killmailTimeMs <= KILL_FEED_WINDOW_MS)
    .sort((a, b) => b.killmailTimeMs - a.killmailTimeMs)
    .slice(0, KILL_FEED_ROWS), [kills, now]);

  return <section className="pmap-feed" aria-label={t('perimeterFeedTitle')}>
    <header>
      <span>{t('perimeterFeedTitle')}</span>
      <small>{t('perimeterFeedWindow')}</small>
    </header>
    {rows.length === 0 ? <p className="pmap-feed__empty">{t('perimeterFeedEmpty')}</p> : <ol>
      {rows.map((kill) => {
        const system = names.get(kill.systemId);
        const minutes = Math.max(0, Math.round((now - kill.killmailTimeMs) / 60_000));
        const fresh = minutes < 5;
        return <li key={kill.killmailId} className={fresh ? 'pmap-feed__row pmap-feed__row--fresh' : 'pmap-feed__row'}>
          <button type="button" onClick={() => onFocus(kill.systemId)}>
            <span className="pmap-feed__victim">{kill.victimShipName ?? t('perimeterFeedUnknownShip')}</span>
            <span className="pmap-feed__by">
              {kill.isSolo
                ? t('perimeterFeedSolo', { ship: kill.finalBlowShipName ?? '?' })
                : t('perimeterFeedGang', { count: String(kill.attackerCount) })}
            </span>
            <span className="pmap-feed__where">
              <i className={securityClassName(system?.security ?? 0)}>{system?.name ?? kill.systemId}</i>
              {' · '}
              {minutes === 0 ? t('perimeterFeedNow') : t('perimeterFeedMinutes', { minutes: String(minutes) })}
            </span>
            <span className="pmap-feed__isk">{formatIskShort(kill.totalValue, locale)}</span>
          </button>
        </li>;
      })}
    </ol>}
  </section>;
}

function formatIskShort(value: number, locale: string): string {
  const units: Array<[number, string, string]> = [
    [1e12, 'трлн', 'T'], [1e9, 'млрд', 'B'], [1e6, 'млн', 'M'], [1e3, 'тыс', 'K'],
  ];
  for (const [size, ru, en] of units) {
    if (value >= size) {
      const number = (value / size).toFixed(value / size >= 100 ? 0 : 1);
      return `${number} ${locale === 'ru' ? ru : en}`;
    }
  }
  return String(Math.round(value));
}

function RouteRibbon({ route, onClear }: { route: MapRouteResponse; onClear: () => void }) {
  const { t } = useI18n();
  const coverage = route.dangerCoverage;
  return <div className="perimeter__route pmap-route">
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
    {/* Полоса прыжков: цвет безопасности слева, полоска опасности справа —
        самый опасный прыжок видно, не читая цифры. */}
    <ol className="pmap-route__list">
      {route.systems.map((system) => {
        const danger = system.danger === null ? null : Math.round(system.danger * 100);
        return <li key={system.systemId} className={danger !== null && danger >= 50 ? 'pmap-route__hop--hot' : undefined}>
          <span className={`pmap-route__sec ${securityClassName(system.security)}`}>{system.security.toFixed(1)}</span>
          <span className="pmap-route__name">{system.name}</span>
          <span className="pmap-route__danger" aria-label={danger === null ? '—' : `${danger}%`}>
            <i style={{ inlineSize: `${danger ?? 0}%` }} />
          </span>
          <span className="pmap-route__pct">{danger === null ? '—' : `${danger}%`}</span>
        </li>;
      })}
    </ol>
  </div>;
}
