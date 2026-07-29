import { describe, expect, it } from 'vitest';
import {
  GLYPH_ZOOM_RATIO,
  MAX_ZOOM_RATIO,
  MIN_ZOOM_RATIO,
  fitScale,
  fitView,
  project,
  zoomAt,
  zoomRatio,
} from '../../web/src/components/map/universe-view.js';

/**
 * Регрессия на реальную поломку: карта рисовалась, а первый же поворот колеса
 * уносил всё за экран. Координаты SDE — сырые метры, поэтому масштаб, при
 * котором Новый Эдем влезает в окно, порядка 1e-15, а пределы зума были
 * записаны абсолютными числами на пятнадцать порядков выше.
 */

/** Приблизительный размах Нового Эдема в метрах. */
const NEW_EDEN: { minX: number; maxX: number; minY: number; maxY: number } = {
  minX: -4.9e17,
  maxX: 4.7e17,
  minY: -4.2e17,
  maxY: 4.6e17,
};
const WIDTH = 1600;
const HEIGHT = 900;

describe('universe viewport', () => {
  it('fits the cluster at a scale that matches the data, not the screen', () => {
    const k = fitScale(NEW_EDEN, WIDTH, HEIGHT);
    expect(k).toBeGreaterThan(0);
    // Именно этот порядок и ломал абсолютные пределы [0.25, 40].
    expect(k).toBeLessThan(1e-12);
  });

  it('centres the cluster on the viewport', () => {
    const view = fitView(NEW_EDEN, WIDTH, HEIGHT);
    const centre = project(view, (NEW_EDEN.minX + NEW_EDEN.maxX) / 2, (NEW_EDEN.minY + NEW_EDEN.maxY) / 2);
    expect(centre.x).toBeCloseTo(WIDTH / 2, 6);
    expect(centre.y).toBeCloseTo(HEIGHT / 2, 6);
  });

  it('keeps every corner on screen at the fit scale', () => {
    const view = fitView(NEW_EDEN, WIDTH, HEIGHT);
    for (const [x, y] of [
      [NEW_EDEN.minX, NEW_EDEN.minY],
      [NEW_EDEN.maxX, NEW_EDEN.maxY],
    ] as const) {
      const point = project(view, x, y);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(WIDTH);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(HEIGHT);
    }
  });

  it('does not throw the map off screen on the first wheel notch', () => {
    const fit = fitView(NEW_EDEN, WIDTH, HEIGHT);
    const zoomed = zoomAt(fit, fit.k, WIDTH / 2, HEIGHT / 2, -100);

    // Масштаб меняется в разумной пропорции, а не на пятнадцать порядков.
    expect(zoomed.k / fit.k).toBeGreaterThan(1);
    expect(zoomed.k / fit.k).toBeLessThan(2);

    // Центр кластера остаётся в кадре — раньше он улетал в бесконечность.
    const centre = project(zoomed, (NEW_EDEN.minX + NEW_EDEN.maxX) / 2, (NEW_EDEN.minY + NEW_EDEN.maxY) / 2);
    expect(centre.x).toBeGreaterThan(0);
    expect(centre.x).toBeLessThan(WIDTH);
    expect(centre.y).toBeGreaterThan(0);
    expect(centre.y).toBeLessThan(HEIGHT);
  });

  it('holds the point under the cursor still', () => {
    const fit = fitView(NEW_EDEN, WIDTH, HEIGHT);
    const cursor = { x: 420, y: 260 };
    // Мир под курсором до зума...
    const worldX = (cursor.x - fit.x) / fit.k;
    const worldY = (cursor.y - fit.y) / fit.k;

    const zoomed = zoomAt(fit, fit.k, cursor.x, cursor.y, -240);
    const after = project(zoomed, worldX, worldY);
    // ...должен остаться ровно под курсором после.
    expect(after.x).toBeCloseTo(cursor.x, 6);
    expect(after.y).toBeCloseTo(cursor.y, 6);
  });

  it('clamps zoom relative to the fit, in both directions', () => {
    const fit = fitView(NEW_EDEN, WIDTH, HEIGHT);

    let view = fit;
    for (let i = 0; i < 200; i += 1) view = zoomAt(view, fit.k, WIDTH / 2, HEIGHT / 2, -300);
    expect(view.k).toBeCloseTo(MAX_ZOOM_RATIO * fit.k, 20);

    view = fit;
    for (let i = 0; i < 200; i += 1) view = zoomAt(view, fit.k, WIDTH / 2, HEIGHT / 2, 300);
    expect(view.k).toBeCloseTo(MIN_ZOOM_RATIO * fit.k, 20);
  });

  it('cannot zoom out far enough to lose the cluster', () => {
    const fit = fitView(NEW_EDEN, WIDTH, HEIGHT);
    let view = fit;
    for (let i = 0; i < 50; i += 1) view = zoomAt(view, fit.k, WIDTH / 2, HEIGHT / 2, 300);
    // Нижний предел — доля масштаба вписывания, поэтому кластер всегда крупнее
    // экрана настолько, чтобы его было видно.
    expect(zoomRatio(view, fit.k)).toBeGreaterThanOrEqual(MIN_ZOOM_RATIO - 1e-9);
  });

  it('reports level of detail relative to the fit', () => {
    const fit = fitView(NEW_EDEN, WIDTH, HEIGHT);
    expect(zoomRatio(fit, fit.k)).toBeCloseTo(1, 9);
    // Подписи и глифы включаются от кратности, а не от абсолютного масштаба —
    // иначе они не появлялись бы никогда.
    const close = { ...fit, k: fit.k * GLYPH_ZOOM_RATIO };
    expect(zoomRatio(close, fit.k)).toBeCloseTo(GLYPH_ZOOM_RATIO, 9);
  });

  it('survives a degenerate fit scale instead of clamping into nonsense', () => {
    const view = { x: 0, y: 0, k: 3 };
    const zoomed = zoomAt(view, 0, 10, 10, -100);
    // Нулевой якорь — не повод зажимать масштаб в диапазон, не связанный с данными.
    expect(zoomed.k).toBeGreaterThan(0);
    expect(Number.isFinite(zoomed.k)).toBe(true);
  });

  it('handles a cluster with no extent at all', () => {
    const k = fitScale({ minX: 5, maxX: 5, minY: 5, maxY: 5 }, WIDTH, HEIGHT);
    expect(Number.isFinite(k)).toBe(true);
    expect(k).toBeGreaterThan(0);
  });
});
