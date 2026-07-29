import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearActiveRoute,
  expireStaleRoutes,
  getActiveRoute,
  onActiveRouteChange,
  rememberRoute,
  resetActiveRoutesForTests,
  routeAheadOf,
} from '../../src/eve-map/active-route.js';

/**
 * Регрессия на реальную жалобу: агент проложил обход, описал его и выставил
 * автопилот — а линия на карте осталась старой. Маршрут узнавала только та
 * поверхность, которая его построила.
 */

const LANE = -2_000_000_042;
const OTHER_LANE = -2_000_000_043;

describe('active route is published, not just stored', () => {
  beforeEach(() => resetActiveRoutesForTests());
  afterEach(() => resetActiveRoutesForTests());

  it('notifies listeners when a route is planned', () => {
    const seen: Array<{ chatId: number; jumps: number | null }> = [];
    onActiveRouteChange((chatId, route) => seen.push({ chatId, jumps: route?.jumps ?? null }));

    rememberRoute(LANE, { systemIds: [1, 2, 3, 4], mode: 'secure', riskWeight: 3 });

    expect(seen).toEqual([{ chatId: LANE, jumps: 3 }]);
  });

  it('notifies when the route goes away', () => {
    rememberRoute(LANE, { systemIds: [1, 2], mode: 'shortest', riskWeight: 0 });
    const seen: Array<number | null> = [];
    onActiveRouteChange((_chatId, route) => seen.push(route?.jumps ?? null));

    clearActiveRoute(LANE);
    expect(seen).toEqual([null]);
    expect(getActiveRoute(LANE)).toBeNull();
  });

  it('treats a one-system result as no route at all', () => {
    const seen: Array<number | null> = [];
    onActiveRouteChange((_chatId, route) => seen.push(route?.jumps ?? null));
    // Маршрут «сюда же» — это не маршрут, и рисовать его нечем.
    rememberRoute(LANE, { systemIds: [42], mode: 'shortest', riskWeight: 0 });
    expect(seen).toEqual([null]);
  });

  it('keeps lanes apart', () => {
    rememberRoute(LANE, { systemIds: [1, 2, 3], mode: 'secure', riskWeight: 1 });
    expect(getActiveRoute(OTHER_LANE)).toBeNull();
    expect(getActiveRoute(LANE)?.jumps).toBe(2);
  });

  it('a listener that throws does not stop the others', () => {
    const seen: number[] = [];
    onActiveRouteChange(() => { throw new Error('boom'); });
    onActiveRouteChange((chatId) => seen.push(chatId));

    expect(() => rememberRoute(LANE, { systemIds: [1, 2], mode: 'shortest', riskWeight: 0 }))
      .not.toThrow();
    expect(seen).toEqual([LANE]);
  });

  it('reports only the part of the route still ahead', () => {
    rememberRoute(LANE, { systemIds: [10, 20, 30, 40], mode: 'secure', riskWeight: 0 });
    expect(routeAheadOf(LANE, 20)).toEqual([30, 40]);
    // Сошёл с маршрута — предупреждать о прыжках, к которым он больше не летит,
    // хуже, чем молчать.
    expect(routeAheadOf(LANE, 999)).toEqual([]);
  });

  /**
   * Истечение было ленивым: запись пропадала для следующего читателя, но
   * открытому потоку об этом никто не сообщал — мёртвая линия висела на экране
   * до перезагрузки страницы.
   */
  it('takes an expired route off the map instead of leaving it drawn', () => {
    const planned = Date.parse('2026-07-29T07:00:00.000Z');
    rememberRoute(LANE, { systemIds: [1, 2, 3], mode: 'secure', riskWeight: 0 }, planned);
    const seen: Array<number | null> = [];
    onActiveRouteChange((_chatId, route) => seen.push(route?.jumps ?? null));

    expect(expireStaleRoutes(planned + 3 * 60 * 60_000)).toBe(1);
    expect(seen).toEqual([null]);
    expect(getActiveRoute(LANE, planned + 3 * 60 * 60_000)).toBeNull();
  });

  it('leaves a live route alone when sweeping', () => {
    const planned = Date.parse('2026-07-29T07:00:00.000Z');
    rememberRoute(LANE, { systemIds: [1, 2, 3], mode: 'secure', riskWeight: 0 }, planned);
    const seen: Array<number | null> = [];
    onActiveRouteChange((_chatId, route) => seen.push(route?.jumps ?? null));

    expect(expireStaleRoutes(planned + 60_000)).toBe(0);
    expect(seen).toEqual([]);
    expect(getActiveRoute(LANE, planned + 60_000)).not.toBeNull();
  });

  it('sweeps every lane, not just the one somebody read', () => {
    const planned = Date.parse('2026-07-29T07:00:00.000Z');
    rememberRoute(LANE, { systemIds: [1, 2], mode: 'secure', riskWeight: 0 }, planned);
    rememberRoute(OTHER_LANE, { systemIds: [3, 4], mode: 'secure', riskWeight: 0 }, planned);

    expect(expireStaleRoutes(planned + 3 * 60 * 60_000)).toBe(2);
  });

  it('reports an expiry once, not on every tick', () => {
    const planned = Date.parse('2026-07-29T07:00:00.000Z');
    rememberRoute(LANE, { systemIds: [1, 2], mode: 'secure', riskWeight: 0 }, planned);
    const seen: Array<number | null> = [];
    onActiveRouteChange((_chatId, route) => seen.push(route?.jumps ?? null));

    const later = planned + 3 * 60 * 60_000;
    expireStaleRoutes(later);
    expireStaleRoutes(later);
    // Подметание идёт каждый тик потока: повторные route:null были бы спамом.
    expect(seen).toEqual([null]);
  });

  it('forgets a route nobody refreshed for hours', () => {
    const planned = Date.parse('2026-07-29T07:00:00.000Z');
    rememberRoute(LANE, { systemIds: [1, 2, 3], mode: 'secure', riskWeight: 0 }, planned);
    expect(getActiveRoute(LANE, planned + 60_000)).not.toBeNull();
    expect(getActiveRoute(LANE, planned + 3 * 60 * 60_000)).toBeNull();
  });
});
