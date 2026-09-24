/**
 * Viewport maths for the whole-cluster map.
 *
 * Extracted from the canvas because this is where the map actually broke: SDE
 * coordinates are raw metres, so the scale that fits New Eden on screen is on
 * the order of 1e-15. Zoom limits written as absolute numbers were fifteen
 * orders of magnitude above the working range — the first wheel notch clamped
 * the scale upward and threw every system off-screen.
 *
 * Every limit here is a multiple of the fit scale, and it is a pure function so
 * that property can be pinned by a test instead of by eye.
 */

export type View = { x: number; y: number; k: number };
export type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

/** Zoom range as multiples of the fit scale. */
export const MIN_ZOOM_RATIO = 0.8;
export const MAX_ZOOM_RATIO = 400;
/** Relative zoom at which per-system glyphs and labels become legible. */
export const GLYPH_ZOOM_RATIO = 2.5;
export const LABEL_ZOOM_RATIO = 6;

/** The scale that fits `bounds` inside a viewport, with a little margin. */
export function fitScale(bounds: Bounds, width: number, height: number): number {
  const spanX = Math.max(1e-9, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-9, bounds.maxY - bounds.minY);
  const raw = Math.min(width / spanX, height / spanY) * 0.9;
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export function fitView(bounds: Bounds, width: number, height: number): View {
  const k = fitScale(bounds, width, height);
  return {
    k,
    x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * k,
    y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
  };
}

/**
 * Apply one wheel notch, keeping the point under the cursor fixed.
 *
 * `fitK` is the anchor for the limits. Passing a bogus or zero fit scale falls
 * back to the current scale rather than clamping into a range that has nothing
 * to do with the data.
 */
export function zoomAt(view: View, fitK: number, px: number, py: number, deltaY: number): View {
  const anchor = Number.isFinite(fitK) && fitK > 0 ? fitK : view.k;
  const factor = Math.exp(-deltaY * 0.0015);
  const k = Math.min(MAX_ZOOM_RATIO * anchor, Math.max(MIN_ZOOM_RATIO * anchor, view.k * factor));
  return {
    k,
    x: px - ((px - view.x) / view.k) * k,
    y: py - ((py - view.y) / view.k) * k,
  };
}

/** Scale relative to the fit, which is what level-of-detail decisions read. */
export function zoomRatio(view: View, fitK: number): number {
  return fitK > 0 ? view.k / fitK : 1;
}

/** Screen position of a world point under the current view. */
export function project(view: View, worldX: number, worldY: number): { x: number; y: number } {
  return { x: worldX * view.k + view.x, y: worldY * view.k + view.y };
}

/**
 * Centre the view on one system, zoomed in at least far enough for its label
 * to be drawn. Used when the pilot asks to be shown a system (an advisory's
 * anchor): selecting it without moving the view left the selection somewhere
 * among 8490 dots, usually off screen.
 */
export function centreOn(
  view: View,
  fitK: number,
  worldX: number,
  worldY: number,
  width: number,
  height: number,
): View {
  const k = Math.max(view.k, fitK * LABEL_ZOOM_RATIO);
  return { k, x: width / 2 - worldX * k, y: height / 2 - worldY * k };
}
