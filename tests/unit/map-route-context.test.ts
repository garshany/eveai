import { afterEach, describe, expect, it } from 'vitest';
import { __testables, resetActiveRoutesForTests } from '../../src/web/map-routes.js';

const { rememberRoute, routeAheadOf, readIdempotencyKey } = __testables;

const CHAT = -2_000_000_000;
const ROUTE = [30000142, 30000144, 30000139, 30002187];
const NOW = Date.parse('2026-07-29T19:00:00.000Z');

describe('active route', () => {
  afterEach(() => resetActiveRoutesForTests());

  it('returns the hops still ahead of the pilot', () => {
    rememberRoute(CHAT, ROUTE, NOW);
    expect(routeAheadOf(CHAT, 30000142, NOW)).toEqual([30000144, 30000139, 30002187]);
    expect(routeAheadOf(CHAT, 30000139, NOW)).toEqual([30002187]);
  });

  it('is empty at the destination', () => {
    rememberRoute(CHAT, ROUTE, NOW);
    expect(routeAheadOf(CHAT, 30002187, NOW)).toEqual([]);
  });

  it('says nothing when the pilot left the planned route', () => {
    rememberRoute(CHAT, ROUTE, NOW);
    // Предупреждать про прыжки, куда пилот уже не летит, хуже, чем молчать.
    expect(routeAheadOf(CHAT, 30009999, NOW)).toEqual([]);
  });

  it('forgets a route nobody refreshed', () => {
    rememberRoute(CHAT, ROUTE, NOW);
    expect(routeAheadOf(CHAT, 30000142, NOW + 3 * 60 * 60_000)).toEqual([]);
  });

  it('ignores a degenerate route', () => {
    rememberRoute(CHAT, [30000142], NOW);
    expect(routeAheadOf(CHAT, 30000142, NOW)).toEqual([]);
  });

  it('keeps lanes apart', () => {
    rememberRoute(CHAT, ROUTE, NOW);
    expect(routeAheadOf(CHAT - 1, 30000142, NOW)).toEqual([]);
  });
});

describe('idempotency key', () => {
  it('accepts a well-formed client key', () => {
    expect(readIdempotencyKey('abcdefghijklmnop')).toBe('abcdefghijklmnop');
  });

  it('generates one for anything else', () => {
    expect(readIdempotencyKey('short')).not.toBe('short');
    expect(readIdempotencyKey(42)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
