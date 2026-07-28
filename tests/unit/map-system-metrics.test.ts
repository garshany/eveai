import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const esiMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/eve/esi-client.js', () => ({ callEsiOperation: esiMock }));

const {
  getSystemProfile,
  hourOfWeekFor,
  mortalityPerThousandJumps,
  pruneHourly,
  resetSystemMetricsForTests,
  runTick,
  sampledHoursFor,
  writeBucket,
} = await import('../../src/eve-map/system-metrics.js');

/** Среда, 2026-07-29, 19:00 UTC — «будни, 19:00 по EVE». */
const HOUR = Date.parse('2026-07-29T19:00:00.000Z');
const SYSTEM = 30000142;

function esiReturns(options: {
  jumps?: Array<{ system_id: number; ship_jumps: number }>;
  kills?: Array<{ system_id: number; ship_kills: number; npc_kills: number; pod_kills: number }>;
  lastModified?: string;
  killsLastModified?: string;
  fail?: boolean;
}): void {
  esiMock.mockImplementation(async (_db: unknown, operation: string) => {
    if (options.fail) return { ok: false, status: 503, error: 'ESI down' };
    const jumpsHeader = options.lastModified ?? 'Wed, 29 Jul 2026 19:00:00 GMT';
    if (operation === 'get_universe_system_jumps') {
      return { ok: true, status: 200, data: options.jumps ?? [], headers: { 'last-modified': jumpsHeader } };
    }
    return {
      ok: true,
      status: 200,
      data: options.kills ?? [],
      headers: { 'last-modified': options.killsLastModified ?? jumpsHeader },
    };
  });
}

describe('hour of week', () => {
  it('is UTC, which is EVE time', () => {
    // Среда = 3-й день недели при воскресенье = 0.
    expect(hourOfWeekFor(HOUR)).toBe(3 * 24 + 19);
  });
});

describe('system metrics accumulation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    esiMock.mockReset();
    resetSystemMetricsForTests();
  });

  afterEach(() => {
    resetSystemMetricsForTests();
    db.close();
  });

  it('stores an hourly bucket and folds it into the weekly profile', () => {
    const written = writeBucket(db, HOUR, [
      { systemId: SYSTEM, shipJumps: 900, shipKills: 3, npcKills: 40, podKills: 1 },
    ]);
    expect(written).toBe(1);

    const profile = getSystemProfile(db, SYSTEM, hourOfWeekFor(HOUR))!;
    expect(profile.samples).toBe(1);
    expect(profile.avgShipJumps).toBe(900);
    expect(profile.avgShipKills).toBe(3);
  });

  it('does not double count when the same bucket is written twice', () => {
    const row = { systemId: SYSTEM, shipJumps: 900, shipKills: 3, npcKills: 0, podKills: 0 };
    writeBucket(db, HOUR, [row]);
    // Рестарт или лишний опрос внутри того же часа попадают в тот же бакет:
    // сложение вместо замены незаметно раздуло бы «сколько тут обычно народу».
    writeBucket(db, HOUR, [row]);

    const profile = getSystemProfile(db, SYSTEM, hourOfWeekFor(HOUR))!;
    expect(profile.samples).toBe(1);
    expect(profile.avgShipJumps).toBe(900);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM map_system_hourly').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('corrects the profile when a bucket is rewritten with new numbers', () => {
    writeBucket(db, HOUR, [{ systemId: SYSTEM, shipJumps: 100, shipKills: 1, npcKills: 0, podKills: 0 }]);
    writeBucket(db, HOUR, [{ systemId: SYSTEM, shipJumps: 400, shipKills: 2, npcKills: 0, podKills: 0 }]);

    const profile = getSystemProfile(db, SYSTEM, hourOfWeekFor(HOUR))!;
    expect(profile.samples).toBe(1);
    expect(profile.avgShipJumps).toBe(400);
    expect(profile.avgShipKills).toBe(2);
  });

  it('averages the same hour across weeks', () => {
    writeBucket(db, HOUR, [{ systemId: SYSTEM, shipJumps: 800, shipKills: 2, npcKills: 0, podKills: 0 }]);
    writeBucket(db, HOUR + 7 * 24 * 3_600_000, [
      { systemId: SYSTEM, shipJumps: 1000, shipKills: 4, npcKills: 0, podKills: 0 },
    ]);

    const profile = getSystemProfile(db, SYSTEM, hourOfWeekFor(HOUR))!;
    expect(profile.samples).toBe(2);
    expect(profile.avgShipJumps).toBe(900);
    expect(profile.avgShipKills).toBe(3);
  });

  it('skips systems with nothing happening', () => {
    // Пустых систем подавляющее большинство; хранить их — умножить таблицу
    // в разы без единого бита информации.
    const written = writeBucket(db, HOUR, [
      { systemId: SYSTEM, shipJumps: 0, shipKills: 0, npcKills: 0, podKills: 0 },
      { systemId: 30000144, shipJumps: 5, shipKills: 0, npcKills: 0, podKills: 0 },
    ]);
    expect(written).toBe(1);
    expect(getSystemProfile(db, SYSTEM, hourOfWeekFor(HOUR))).toBeNull();
  });

  it('keeps the weekly profile when raw hourly rows are pruned', () => {
    const old = HOUR - 60 * 24 * 3_600_000;
    writeBucket(db, old, [{ systemId: SYSTEM, shipJumps: 900, shipKills: 3, npcKills: 0, podKills: 0 }]);

    const pruned = pruneHourly(db, HOUR);
    expect(pruned).toBe(1);
    // Сырьё уходит, память остаётся — ради этого всё и копится.
    expect(getSystemProfile(db, SYSTEM, hourOfWeekFor(old))?.samples).toBe(1);
  });

  it('computes deaths per thousand jumps and refuses to divide by nothing', () => {
    writeBucket(db, HOUR, [{ systemId: SYSTEM, shipJumps: 1000, shipKills: 3, npcKills: 0, podKills: 0 }]);
    expect(mortalityPerThousandJumps(db, SYSTEM, hourOfWeekFor(HOUR))).toBeCloseTo(3, 5);

    writeBucket(db, HOUR, [{ systemId: 30000144, shipJumps: 0, shipKills: 3, npcKills: 0, podKills: 0 }]);
    // Три кила при нулевом трафике — не «бесконечная смертность», а «не знаю».
    expect(mortalityPerThousandJumps(db, 30000144, hourOfWeekFor(HOUR))).toBeNull();
  });

  it('merges both endpoints into one bucket keyed by Last-Modified', async () => {
    esiReturns({
      jumps: [{ system_id: SYSTEM, ship_jumps: 900 }],
      kills: [{ system_id: SYSTEM, ship_kills: 3, npc_kills: 40, pod_kills: 1 }],
    });

    const result = await runTick(db, HOUR + 12 * 60_000);
    expect(result.error).toBeNull();
    // Оба эндпоинта пишут свои колонки в один и тот же бакет.
    expect(result.written).toBe(2);
    // Ключ бакета — заголовок ответа, а не настенные часы.
    expect(result.hourStartMs).toBe(HOUR);

    const row = db.prepare('SELECT * FROM map_system_hourly').get() as Record<string, number>;
    expect(row.ship_jumps).toBe(900);
    expect(row.ship_kills).toBe(3);
    expect(row.npc_kills).toBe(40);
  });

  it('a second tick inside the same hour changes nothing', async () => {
    esiReturns({
      jumps: [{ system_id: SYSTEM, ship_jumps: 900 }],
      kills: [{ system_id: SYSTEM, ship_kills: 3, npc_kills: 0, pod_kills: 0 }],
    });
    await runTick(db, HOUR + 12 * 60_000);
    await runTick(db, HOUR + 40 * 60_000);

    const profile = getSystemProfile(db, SYSTEM, hourOfWeekFor(HOUR))!;
    expect(profile.samples).toBe(1);
    expect(profile.avgShipJumps).toBe(900);
  });

  it('never folds one endpoint\'s hour into the other\'s bucket', async () => {
    // Эндпоинты публикуются на своих границах. Раньше более новый складывался
    // в более старый бакет, и трафик 20:00 навсегда становился частью профиля
    // 19:00.
    esiReturns({
      jumps: [{ system_id: SYSTEM, ship_jumps: 900 }],
      kills: [{ system_id: SYSTEM, ship_kills: 7, npc_kills: 0, pod_kills: 0 }],
      lastModified: 'Wed, 29 Jul 2026 19:00:00 GMT',
      killsLastModified: 'Wed, 29 Jul 2026 20:00:00 GMT',
    });
    await runTick(db, HOUR + 61 * 60_000);

    const evening = getSystemProfile(db, SYSTEM, hourOfWeekFor(HOUR))!;
    expect(evening.avgShipJumps).toBe(900);
    expect(evening.avgShipKills).toBe(0);

    const later = getSystemProfile(db, SYSTEM, hourOfWeekFor(HOUR + 3_600_000))!;
    expect(later.avgShipKills).toBe(7);
    expect(later.avgShipJumps).toBe(0);
  });

  it('a jumps write does not erase kills already recorded for that hour', () => {
    writeBucket(db, HOUR, [{ systemId: SYSTEM, shipJumps: 0, shipKills: 5, npcKills: 2, podKills: 0 }], 'kills');
    writeBucket(db, HOUR, [{ systemId: SYSTEM, shipJumps: 900, shipKills: 0, npcKills: 0, podKills: 0 }], 'jumps');

    const row = db.prepare('SELECT ship_jumps, ship_kills FROM map_system_hourly WHERE system_id = ?')
      .get(SYSTEM) as { ship_jumps: number; ship_kills: number };
    expect(row).toEqual({ ship_jumps: 900, ship_kills: 5 });
  });

  it('survives an ESI failure without writing a partial bucket', async () => {
    esiReturns({ fail: true });
    const result = await runTick(db, HOUR);
    expect(result.written).toBe(0);
    expect(result.error).toContain('ESI down');
    const rows = db.prepare('SELECT COUNT(*) AS n FROM map_system_hourly').get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe('quiet hours dilute the average', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    resetSystemMetricsForTests();
  });
  afterEach(() => { resetSystemMetricsForTests(); db.close(); });

  it('counts an observed hour even when the system was absent from the payload', () => {
    const WEEK = 7 * 24 * 3_600_000;
    // Неделя 1: система активна. Недели 2 и 3: ESI её вообще не вернул —
    // это настоящие нули, а не отсутствие наблюдения.
    writeBucket(db, HOUR, [{ systemId: SYSTEM, shipJumps: 900, shipKills: 3, npcKills: 0, podKills: 0 }], 'jumps');
    writeBucket(db, HOUR + WEEK, [{ systemId: 30000144, shipJumps: 10, shipKills: 0, npcKills: 0, podKills: 0 }], 'jumps');
    writeBucket(db, HOUR + 2 * WEEK, [{ systemId: 30000144, shipJumps: 10, shipKills: 0, npcKills: 0, podKills: 0 }], 'jumps');

    const profile = getSystemProfile(db, SYSTEM, hourOfWeekFor(HOUR))!;
    expect(profile.samples).toBe(3);
    // 900 за три наблюдённых часа, а не 900 за один «когда было шумно».
    expect(profile.avgShipJumps).toBe(300);
  });

  it('does not inflate the denominator on a re-poll of the same hour', () => {
    writeBucket(db, HOUR, [{ systemId: SYSTEM, shipJumps: 900, shipKills: 0, npcKills: 0, podKills: 0 }], 'jumps');
    writeBucket(db, HOUR, [{ systemId: SYSTEM, shipJumps: 900, shipKills: 0, npcKills: 0, podKills: 0 }], 'jumps');
    expect(sampledHoursFor(db, hourOfWeekFor(HOUR))).toBe(1);
  });

  it('counts an hour once even though two endpoints report it', () => {
    writeBucket(db, HOUR, [{ systemId: SYSTEM, shipJumps: 900, shipKills: 0, npcKills: 0, podKills: 0 }], 'jumps');
    writeBucket(db, HOUR, [{ systemId: SYSTEM, shipJumps: 0, shipKills: 4, npcKills: 0, podKills: 0 }], 'kills');
    expect(sampledHoursFor(db, hourOfWeekFor(HOUR))).toBe(1);
  });
});
