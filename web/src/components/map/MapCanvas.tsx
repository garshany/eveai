/**
 * Холст «Периметра»: камера, зум, попадания курсором и цикл отрисовки.
 *
 * Камера ведёт себя как в навигаторе: следует за пилотом, плавно доезжает на
 * прыжке, отъезжает, пока прыжки идут часто, и возвращается ближе, когда пилот
 * стоит. Любой пан пользователя отпускает следование — карта не должна
 * вырывать управление из рук.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import type { MapBubble } from '../../types';
import { cameraTargetFor, easeToward, focusTargetFor, isSettled, pruneJumpTimes, type CameraTarget } from './camera';
import type { Layout } from './layout';
import {
  buildHitIndex,
  buildRenderNodes,
  pickNode,
  render,
  type KillFlash,
  type RenderNode,
} from './renderer';

type Props = {
  bubble: MapBubble;
  layout: Layout;
  pilotSystemId: number | null;
  pilotOnline: boolean;
  selectedSystemId: number | null;
  routeSystemIds: number[];
  flashes: KillFlash[];
  /** Растёт на каждом прыжке: триггер доводки камеры. */
  jumpCounter: number;
  follow: boolean;
  /**
   * Просьба показать систему (якорь совета в чате). Новый объект — новая
   * просьба, даже к той же системе: пилот мог увести камеру и нажать снова.
   */
  focus?: { systemId: number } | null;
  onFollowChange: (follow: boolean) => void;
  onSelect: (systemId: number | null) => void;
};

const MIN_SCALE = 0.15;
const MAX_SCALE = 6;
/** Насколько быстро камера догоняет цель за кадр. */
const EASE = 0.14;

export function MapCanvas({
  bubble,
  layout,
  pilotSystemId,
  pilotOnline,
  selectedSystemId,
  routeSystemIds,
  flashes,
  jumpCounter,
  follow,
  focus = null,
  onFollowChange,
  onSelect,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const zoomRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const jumpTimesRef = useRef<number[]>([]);
  const followRef = useRef(follow);
  followRef.current = follow;
  // Камера читает эти два значения прямо из кадра. Держать цель в отдельном
  // эффекте оказалось ловушкой: доводка замирала на полпути, стоило эффекту
  // переехать, и карта оставалась смещённой без единой ошибки в консоли.
  const layoutRef = useRef<Layout>(layout);
  layoutRef.current = layout;
  const pilotRef = useRef<number | null>(pilotSystemId);
  pilotRef.current = pilotSystemId;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  // Система, к которой камера едет по просьбе; гаснет, когда доехали, или
  // когда пилот сам взялся за карту.
  const focusRef = useRef<number | null>(null);
  useEffect(() => {
    focusRef.current = focus?.systemId ?? null;
  }, [focus]);

  const nodes = useMemo<RenderNode[]>(() => buildRenderNodes(bubble, layout), [bubble, layout]);
  const hitIndex = useMemo(() => buildHitIndex(nodes), [nodes]);

  // Всё, что цикл отрисовки читает покадрово, живёт в одном ref.
  const sceneRef = useRef({
    nodes, bubble, layout, pilotSystemId, pilotOnline, selectedSystemId,
    hoveredSystemId: hovered, routeSystemIds, flashes,
  });
  sceneRef.current = {
    nodes, bubble, layout, pilotSystemId, pilotOnline, selectedSystemId,
    hoveredSystemId: hovered, routeSystemIds, flashes,
  };

  const reducedMotion = useMemo(
    () => typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    [],
  );

  /** Куда камера хочет попасть прямо сейчас; математика — в camera.ts. */
  const cameraTarget = useCallback((): CameraTarget | null => {
    const { width, height } = sizeRef.current;
    const pilotId = pilotRef.current;
    const now = Date.now();
    jumpTimesRef.current = pruneJumpTimes(jumpTimesRef.current, now);
    return cameraTargetFor({
      width,
      height,
      pilot: pilotId === null ? null : layoutRef.current.get(pilotId) ?? null,
      jumpTimes: jumpTimesRef.current,
      now,
    });
  }, []);

  // --- Размер и devicePixelRatio ------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: parent.clientWidth, height: parent.clientHeight });
    });
    observer.observe(parent);
    setSize({ width: parent.clientWidth, height: parent.clientHeight });
    return () => observer.disconnect();
  }, []);

  // --- Зум и пан -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const behavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([MIN_SCALE, MAX_SCALE])
      .on('zoom', (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        transformRef.current = event.transform;
        // Жест пользователя (а не программная доводка) отпускает следование.
        if (event.sourceEvent) focusRef.current = null;
        if (event.sourceEvent && followRef.current) onFollowChange(false);
      });
    zoomRef.current = behavior;
    select(canvas).call(behavior);
    return () => { select(canvas).on('.zoom', null); };
  }, [onFollowChange]);

  useEffect(() => {
    if (jumpCounter > 0) jumpTimesRef.current.push(Date.now());
  }, [jumpCounter]);

  // --- Цикл отрисовки ------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size.width * ratio;
    canvas.height = size.height * ratio;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    let frame = 0;
    const loop = (): void => {
      // Цель считается заново каждый кадр, пока включено следование: пилот
      // прыгает, кольца перестраиваются, панель меняет ширину — всё это меняет
      // ответ, и ни одно из этих событий не должно требовать своего эффекта.
      // A system outside the bubble cannot be shown here; forget the request
      // rather than yanking the camera whenever it later drifts into range.
      if (focusRef.current !== null && !layoutRef.current.has(focusRef.current)) focusRef.current = null;
      // Following the pilot supersedes the request; it must not resurface the
      // next time following is switched off.
      if (followRef.current) focusRef.current = null;
      const focusId = followRef.current ? null : focusRef.current;
      const target = followRef.current
        ? cameraTarget()
        : focusId === null
          ? null
          : focusTargetFor({
            width: sizeRef.current.width,
            height: sizeRef.current.height,
            point: layoutRef.current.get(focusId) ?? null,
            k: transformRef.current.k,
          });
      if (target) {
        const current = transformRef.current;
        if (isSettled(current, target)) {
          if (focusId !== null) focusRef.current = null;
        } else {
          const stepped = easeToward(current, target, reducedMotion ? 1 : EASE);
          const next = zoomIdentity.translate(stepped.x, stepped.y).scale(stepped.k);
          transformRef.current = next;
          // Трансформация возвращается в d3-zoom, иначе следующий жест
          // пользователя прыгнет со старой позиции.
          select(canvas).property('__zoom', next);
        }
      }

      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const scene = sceneRef.current;
      render(ctx, scene.nodes, {
        bubble: scene.bubble,
        layout: scene.layout,
        transform: transformRef.current,
        pilotSystemId: scene.pilotSystemId,
        pilotOnline: scene.pilotOnline,
        selectedSystemId: scene.selectedSystemId,
        hoveredSystemId: scene.hoveredSystemId,
        routeSystemIds: scene.routeSystemIds,
        flashes: scene.flashes,
        showLabels: true,
        now: Date.now(),
        reducedMotion,
      }, sizeRef.current.width, sizeRef.current.height);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
    // Всё, что меняется покадрово, читается из sceneRef: пересоздавать цикл на
    // каждый новый проп значит терять кадр и сбрасывать размер холста впустую.
  }, [size, reducedMotion, cameraTarget]);

  // --- Указатель -----------------------------------------------------------
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return transformRef.current.invert([clientX - rect.left, clientY - rect.top]);
  }, []);

  const handleMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const world = toWorld(event.clientX, event.clientY);
    if (!world) return;
    // Радиус попадания в мировых единицах: на отдалении палец должен ловить
    // узел так же уверенно, как курсор вблизи.
    const radius = 14 / transformRef.current.k;
    setHovered(pickNode(hitIndex, world[0], world[1], radius)?.systemId ?? null);
  }, [hitIndex, toWorld]);

  const handleClick = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const world = toWorld(event.clientX, event.clientY);
    if (!world) return;
    const radius = 14 / transformRef.current.k;
    onSelect(pickNode(hitIndex, world[0], world[1], radius)?.systemId ?? null);
  }, [hitIndex, onSelect, toWorld]);

  return <canvas
    ref={canvasRef}
    className="perimeter-canvas"
    onPointerMove={handleMove}
    onPointerLeave={() => setHovered(null)}
    onPointerUp={handleClick}
  />;
}
