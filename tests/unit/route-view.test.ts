import { describe, expect, it } from 'vitest';
import {
  hiddenHopCount,
  routeBreaks,
  splitRouteRuns,
} from '../../web/src/components/map/route-view.js';

/**
 * Регрессия на реальную поломку: маршрут лоцмана рисовался только на «Всей
 * карте», а когда его наконец пустили в пузырь, выяснилось, что рендерер
 * пропускал неразмещаемые системы и продолжал ту же линию — то есть соединял
 * прямой две системы без общего гейта и рисовал прыжок, которого нет.
 *
 * Каждый тест ниже называет способ соврать про маршрут.
 */

/** Пузырь радиуса 5 вокруг Dodixie: соседи есть, дальний конец маршрута — нет. */
const IN_BUBBLE = new Set([10, 20, 30, 60, 70]);
const present = (id: number): boolean => IN_BUBBLE.has(id);

describe('route runs inside a radius-limited bubble', () => {
  it('says nothing about an empty route', () => {
    expect(splitRouteRuns([], present)).toEqual([]);
    expect(hiddenHopCount([], present)).toBe(0);
    expect(routeBreaks([], present)).toEqual({ exits: [], entries: [] });
  });

  it('treats a one-system route as a point, not a line', () => {
    expect(splitRouteRuns([10], present)).toEqual([[10]]);
    // Одна система — ноль прыжков, скрывать нечего.
    expect(hiddenHopCount([10], present)).toBe(0);
  });

  it('draws nothing when the whole route is outside the bubble', () => {
    expect(splitRouteRuns([41, 42, 43], present)).toEqual([]);
    expect(hiddenHopCount([41, 42, 43], present)).toBe(2);
  });

  it('never puts two non-adjacent systems in one run', () => {
    // 30 и 60 в пузыре, но между ними лежит 40, которого нет. Один отрезок
    // здесь означал бы нарисованный гейт 30↔60, которого не существует.
    const runs = splitRouteRuns([10, 20, 30, 40, 50, 60, 70], present);
    expect(runs).toEqual([[10, 20, 30], [60, 70]]);
  });

  it('splits a route that leaves the bubble and comes back', () => {
    expect(splitRouteRuns([10, 99, 20], present)).toEqual([[10], [20]]);
  });

  it('marks where the line stops and where it picks up again', () => {
    const breaks = routeBreaks([10, 20, 30, 40, 50, 60, 70], present);
    // 30 — последняя видимая перед разрывом, 60 — первая после него.
    expect(breaks.exits).toEqual([30]);
    expect(breaks.entries).toEqual([60]);
  });

  it('does not mark the ends of the route as breaks', () => {
    // Маршрут целиком в пузыре: обрывать нечего.
    const breaks = routeBreaks([10, 20, 30], present);
    expect(breaks).toEqual({ exits: [], entries: [] });
  });

  it('counts hidden jumps, not hidden systems', () => {
    // 10→20→30 видны (2 прыжка); 30→40, 40→50, 50→60 скрыты; 60→70 виден.
    expect(hiddenHopCount([10, 20, 30, 40, 50, 60, 70], present)).toBe(3);
  });

  it('counts a hop as hidden when either end is missing', () => {
    // Один прыжок, один конец за пузырём — показать его нечем.
    expect(hiddenHopCount([30, 40], present)).toBe(1);
    expect(hiddenHopCount([40, 30], present)).toBe(1);
  });
});
