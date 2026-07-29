import { useEffect, useMemo, useRef, useState } from 'react';
import type { UniverseActivity, UniverseStatic } from '../../types';
import {
  GLYPH_ZOOM_RATIO,
  LABEL_ZOOM_RATIO,
  fitView,
  zoomAt,
  zoomRatio,
  type View,
} from './universe-view';

/**
 * The whole of New Eden on one canvas.
 *
 * 8490 systems and ~14000 links is well inside what Canvas 2D handles, but only
 * if the frame refuses to do pointless work. Three things carry it:
 *
 *   • **Culling** — nothing outside the viewport is drawn. Zoomed into one
 *     region, the frame touches a few hundred systems instead of all of them.
 *   • **Batching** — every gate link goes into one path and one stroke. Fourteen
 *     thousand separate strokes is what actually kills a canvas, not the number
 *     of line segments.
 *   • **Level of detail** — labels and per-system glyphs only appear once the
 *     view is close enough for them to be legible. Zoomed out they would be an
 *     unreadable smear that costs the whole frame budget to draw.
 *
 * This is deliberately a separate component from the bubble canvas. The bubble
 * is ego-centric, animated and pilot-relative; this is a static-geometry atlas
 * with a live overlay. Sharing one renderer between them would mean every draw
 * call carrying a mode flag.
 */

export type UniverseCanvasProps = {
  universe: UniverseStatic;
  activity: UniverseActivity | null;
  /** Where the pilot is, drawn as the one node that is always labelled. */
  currentSystemId: number | null;
  /** Systems on the active route, drawn as a ribbon over the atlas. */
  routeSystemIds: number[];
  avoidedSystemIds: number[];
  showTraffic: boolean;
  showCamps: boolean;
  onSelect: (systemId: number) => void;
  selectedSystemId: number | null;
};

const BAND_COLOURS: Record<string, string> = {
  calm: '#2f6f52',
  watch: '#8a8a2f',
  elevated: '#b8792c',
  hostile: '#c2452f',
  lethal: '#e4443c',
};

export function UniverseCanvas({
  universe,
  activity,
  currentSystemId,
  routeSystemIds,
  avoidedSystemIds,
  showTraffic,
  showCamps,
  onSelect,
  selectedSystemId,
}: UniverseCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  /** Scale at which the whole cluster fits; every zoom limit is a multiple of it. */
  const fitKRef = useRef<number>(1);
  const [, forceRedraw] = useState(0);

  // Index by system id once: the activity payload is column arrays, and looking
  // a system up per frame with indexOf would turn an O(n) frame into O(n²).
  const indexById = useMemo(() => {
    const map = new Map<number, number>();
    for (let i = 0; i < universe.systemIds.length; i += 1) map.set(universe.systemIds[i]!, i);
    return map;
  }, [universe]);

  const activityById = useMemo(() => {
    const map = new Map<number, { kills: number; gateKills: number; band: string; jumps: number }>();
    if (!activity) return map;
    for (let i = 0; i < activity.systemIds.length; i += 1) {
      const id = activity.systemIds[i]!;
      map.set(id, {
        kills: activity.kills1h[i] ?? 0,
        gateKills: activity.gateKills1h[i] ?? 0,
        band: activity.bands[i] ?? 'calm',
        jumps: activity.baselineJumps[String(id)] ?? 0,
      });
    }
    return map;
  }, [activity]);

  const routeSet = useMemo(() => new Set(routeSystemIds), [routeSystemIds]);
  const avoidSet = useMemo(() => new Set(avoidedSystemIds), [avoidedSystemIds]);

  // Fit the whole cluster on first paint, so the view never opens on empty space.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const view = fitView(universe.bounds, wrap.clientWidth, wrap.clientHeight);
    fitKRef.current = view.k;
    viewRef.current = view;
    forceRedraw((value) => value + 1);
  }, [universe]);

  // Pan, zoom and hit testing. Written directly rather than through a zoom
  // library because the transform is also what culling and LOD read.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;

    const onDown = (event: PointerEvent): void => {
      dragging = true;
      moved = 0;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent): void => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = event.clientX;
      lastY = event.clientY;
      viewRef.current = { ...viewRef.current, x: viewRef.current.x + dx, y: viewRef.current.y + dy };
      forceRedraw((value) => value + 1);
    };
    const onUp = (event: PointerEvent): void => {
      dragging = false;
      canvas.releasePointerCapture(event.pointerId);
      // A drag is not a click. Without this threshold every pan selects
      // whatever system happened to be under the finger when it lifted.
      if (moved > 6) return;
      const hit = pick(event);
      if (hit !== null) onSelect(hit);
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      viewRef.current = zoomAt(viewRef.current, fitKRef.current, px, py, event.deltaY);
      forceRedraw((value) => value + 1);
    };

    const pick = (event: PointerEvent): number | null => {
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const view = viewRef.current;
      const tolerance = 10;
      let best: number | null = null;
      let bestDistance = tolerance;
      for (let i = 0; i < universe.systemIds.length; i += 1) {
        const sx = universe.x[i]! * view.k + view.x;
        const sy = universe.y[i]! * view.k + view.y;
        if (sx < -tolerance || sy < -tolerance || sx > rect.width + tolerance || sy > rect.height + tolerance) {
          continue;
        }
        const distance = Math.hypot(sx - px, sy - py);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = universe.systemIds[i]!;
        }
      }
      return best;
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [universe, onSelect]);

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ratio = window.devicePixelRatio || 1;
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const view = viewRef.current;
    const margin = 40;
    const visible = (sx: number, sy: number): boolean =>
      sx >= -margin && sy >= -margin && sx <= width + margin && sy <= height + margin;

    const screenX = (i: number): number => universe.x[i]! * view.k + view.x;
    const screenY = (i: number): number => universe.y[i]! * view.k + view.y;
    const zoom = zoomRatio(view, fitKRef.current);

    // --- gate links, one path, one stroke ---------------------------------
    ctx.strokeStyle = 'rgba(150, 170, 200, 0.18)';
    ctx.lineWidth = Math.min(1.4, 0.3 + 0.25 * Math.sqrt(zoom));
    ctx.beginPath();
    for (let e = 0; e < universe.edges.length; e += 2) {
      const a = indexById.get(universe.edges[e]!);
      const b = indexById.get(universe.edges[e + 1]!);
      if (a === undefined || b === undefined) continue;
      const ax = screenX(a);
      const ay = screenY(a);
      const bx = screenX(b);
      const by = screenY(b);
      if (!visible(ax, ay) && !visible(bx, by)) continue;
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();

    // --- route ribbon ------------------------------------------------------
    if (routeSystemIds.length > 1) {
      ctx.strokeStyle = 'rgba(110, 231, 255, 0.85)';
      ctx.lineWidth = Math.min(4, 1 + 0.6 * Math.sqrt(zoom));
      ctx.beginPath();
      let started = false;
      for (const systemId of routeSystemIds) {
        const index = indexById.get(systemId);
        if (index === undefined) continue;
        const sx = screenX(index);
        const sy = screenY(index);
        if (started) ctx.lineTo(sx, sy);
        else {
          ctx.moveTo(sx, sy);
          started = true;
        }
      }
      ctx.stroke();
    }

    // --- systems -----------------------------------------------------------
    const showGlyphs = zoom >= GLYPH_ZOOM_RATIO;
    const showLabels = zoom >= LABEL_ZOOM_RATIO;

    for (let i = 0; i < universe.systemIds.length; i += 1) {
      const sx = screenX(i);
      const sy = screenY(i);
      if (!visible(sx, sy)) continue;

      const id = universe.systemIds[i]!;
      const security = universe.security[i]!;
      const live = activityById.get(id);

      // Size carries traffic when the layer is on, so a busy pipe reads as a
      // bigger dot without stealing the colour channel from danger.
      let radius = 1.6 + Math.min(1.8, zoom * 0.35);
      if (showTraffic && live && live.jumps > 0) {
        radius += Math.min(3.2, Math.log10(live.jumps + 1) * 1.4);
      }

      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fillStyle = securityColour(security);
      ctx.fill();

      // Threat is the outline, never the fill: security colour is what a
      // capsuleer's reflexes already read, and overwriting it would fight
      // fifteen years of muscle memory.
      if (live && live.band !== 'calm') {
        ctx.strokeStyle = BAND_COLOURS[live.band] ?? BAND_COLOURS.elevated!;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 2.2, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (avoidSet.has(id)) {
        ctx.strokeStyle = 'rgba(255, 120, 120, 0.9)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(sx - 4, sy - 4);
        ctx.lineTo(sx + 4, sy + 4);
        ctx.moveTo(sx + 4, sy - 4);
        ctx.lineTo(sx - 4, sy + 4);
        ctx.stroke();
      }

      if (showGlyphs && showCamps && live && live.gateKills >= 2) {
        ctx.fillStyle = '#e4443c';
        ctx.font = `${Math.min(14, 8 + zoom)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('☠', sx, sy - radius - 4);
      }

      if (id === selectedSystemId || id === currentSystemId) {
        ctx.strokeStyle = id === currentSystemId ? '#6ee7ff' : '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Labels are the single most expensive thing on this canvas: measuring
      // and rasterising 8490 strings costs more than everything above put
      // together, and at this zoom they would overlap into noise anyway.
      const named = showLabels || id === currentSystemId || id === selectedSystemId || routeSet.has(id);
      if (named) {
        ctx.fillStyle = 'rgba(226, 232, 240, 0.92)';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(universe.names[i]!, sx + radius + 4, sy + 3.5);
      }
    }
  });

  return <div className="perimeter__universe" ref={wrapRef}>
    <canvas ref={canvasRef} className="perimeter__canvas" />
  </div>;
}

/** The colour ramp a capsuleer already reads without a legend. */
function securityColour(security: number): string {
  if (security >= 0.9) return '#2f9bd8';
  if (security >= 0.75) return '#3fbf6f';
  if (security >= 0.5) return '#9fd14f';
  if (security >= 0.45) return '#e8d44d';
  if (security > 0) return '#e08a3c';
  return '#c2452f';
}
