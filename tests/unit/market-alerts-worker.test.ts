import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../../src/db/sqlite.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  runMarketAlertsTick,
  stopMarketAlertsWorker,
  type MarketAlertNotificationSender,
} from '../../src/eve/market-alerts-worker.js';

const FORGE = 10000002;
const DOMAIN = 10000043;
const TRITANIUM = 34;
const PYERITE = 35;

let db: Database.Database;
let orderId = 1;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, 'Tritanium', 1, '{}')").run(TRITANIUM);
  db.prepare("INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, 'Pyerite', 1, '{}')").run(PYERITE);
  db.prepare("INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, 'The Forge', '{}')").run(FORGE);
  db.prepare("INSERT INTO sde_regions (region_id, name, data_json) VALUES (?, 'Domain', '{}')").run(DOMAIN);
});

afterEach(async () => {
  await stopMarketAlertsWorker();
  db.close();
});

function addUser(userId: number): void {
  db.prepare(
    "INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
  ).run(userId, `user:${userId}`);
}

function addOrder(regionId: number, typeId: number, price: number, isBuyOrder: boolean): void {
  db.prepare(`
    INSERT INTO market_orders (
      order_id, type_id, region_id, system_id, station_id, location_id,
      is_buy_order, price, volume_remain, volume_total, min_volume, duration, range, issued
    ) VALUES (?, ?, ?, 30000142, 60003760, 60003760, ?, ?, 100, 100, 1, 90, 'region', '2026-07-27T09:55:00Z')
  `).run(orderId, typeId, regionId, isBuyOrder ? 1 : 0, price);
  orderId += 1;
}

function addAlert(
  userId: number,
  overrides: Partial<{
    typeId: number;
    regionId: number;
    side: 'sell' | 'buy';
    comparator: 'above' | 'below';
    threshold: number;
    status: 'active' | 'triggered' | 'disabled';
  }> = {},
): number {
  const result = db.prepare(`
    INSERT INTO market_price_alerts (user_id, type_id, region_id, side, comparator, threshold_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    overrides.typeId ?? TRITANIUM,
    overrides.regionId ?? FORGE,
    overrides.side ?? 'sell',
    overrides.comparator ?? 'above',
    overrides.threshold ?? 100,
    overrides.status ?? 'active',
  );
  return Number(result.lastInsertRowid);
}

function alertRow(alertId: number) {
  return db.prepare(
    'SELECT status, triggered_at, trigger_price FROM market_price_alerts WHERE alert_id = ?',
  ).get(alertId) as { status: string; triggered_at: string | null; trigger_price: number | null };
}

function eventRows() {
  return db.prepare(
    'SELECT event_id, alert_id, user_id, type_id, price, threshold, triggered_at, delivered_at FROM market_alert_events ORDER BY event_id',
  ).all() as Array<{
    event_id: number;
    alert_id: number;
    user_id: number;
    type_id: number;
    price: number;
    threshold: number;
    triggered_at: string;
    delivered_at: string | null;
  }>;
}

function recordingSender(): { sendNotification: MarketAlertNotificationSender; calls: Array<{ userId: number; text: string }> } {
  const calls: Array<{ userId: number; text: string }> = [];
  return {
    calls,
    sendNotification: async (userId, text) => {
      calls.push({ userId, text });
    },
  };
}

describe('runMarketAlertsTick firing matrix', () => {
  it('fires a sell/above alert at the best ask (MIN sell price)', async () => {
    addUser(1);
    const alertId = addAlert(1, { side: 'sell', comparator: 'above', threshold: 100 });
    addOrder(FORGE, TRITANIUM, 105, false);
    addOrder(FORGE, TRITANIUM, 110, false); // worse ask: best stays 105
    addOrder(FORGE, TRITANIUM, 400, true); // buy side: irrelevant for a sell alert
    const { sendNotification, calls } = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification });

    expect(alertRow(alertId)).toMatchObject({ status: 'triggered', trigger_price: 105 });
    expect(alertRow(alertId).triggered_at).toEqual(expect.any(String));
    expect(eventRows()).toHaveLength(1);
    expect(eventRows()[0]).toMatchObject({
      alert_id: alertId,
      user_id: 1,
      type_id: TRITANIUM,
      price: 105,
      threshold: 100,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userId).toBe(1);
    expect(calls[0]?.text).toContain('🔔 Tritanium: sell above 100 ISK — сейчас 105 ISK (The Forge)');
    expect(eventRows()[0]?.delivered_at).toEqual(expect.any(String));
  });

  it('fires a sell/below alert when the best ask drops to the threshold', async () => {
    addUser(1);
    const alertId = addAlert(1, { side: 'sell', comparator: 'below', threshold: 100 });
    addOrder(FORGE, TRITANIUM, 95, false);
    addOrder(FORGE, TRITANIUM, 99, false); // best ask is 95
    const { sendNotification, calls } = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification });

    expect(alertRow(alertId)).toMatchObject({ status: 'triggered', trigger_price: 95 });
    expect(eventRows()[0]).toMatchObject({ price: 95, threshold: 100 });
    expect(calls[0]?.text).toContain('sell below 100 ISK — сейчас 95 ISK');
  });

  it('fires a buy/above alert at the best bid (MAX buy price)', async () => {
    addUser(1);
    const alertId = addAlert(1, { side: 'buy', comparator: 'above', threshold: 100 });
    addOrder(FORGE, TRITANIUM, 105, true);
    addOrder(FORGE, TRITANIUM, 110, true); // best bid is 110
    addOrder(FORGE, TRITANIUM, 50, false); // sell side: irrelevant for a buy alert
    const { sendNotification, calls } = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification });

    expect(alertRow(alertId)).toMatchObject({ status: 'triggered', trigger_price: 110 });
    expect(eventRows()[0]).toMatchObject({ price: 110, threshold: 100 });
    expect(calls[0]?.text).toContain('buy above 100 ISK — сейчас 110 ISK');
  });

  it('fires a buy/below alert when the best bid falls through the threshold', async () => {
    addUser(1);
    const alertId = addAlert(1, { side: 'buy', comparator: 'below', threshold: 100 });
    addOrder(FORGE, TRITANIUM, 95, true);
    const { sendNotification } = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification });

    expect(alertRow(alertId)).toMatchObject({ status: 'triggered', trigger_price: 95 });
    expect(eventRows()).toHaveLength(1);
  });

  it('does not fire when the threshold is not crossed', async () => {
    addUser(1);
    const alertId = addAlert(1, { side: 'sell', comparator: 'above', threshold: 200 });
    addOrder(FORGE, TRITANIUM, 105, false);
    const { sendNotification, calls } = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification });

    expect(alertRow(alertId)).toMatchObject({ status: 'active', triggered_at: null, trigger_price: null });
    expect(eventRows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('does not fire when the book has no orders for the pair (best price NULL)', async () => {
    addUser(1);
    const alertId = addAlert(1, { side: 'sell', comparator: 'below', threshold: 100 });
    addOrder(FORGE, PYERITE, 10, false); // different type
    addOrder(DOMAIN, TRITANIUM, 10, false); // different region
    addOrder(FORGE, TRITANIUM, 10, true); // wrong side for a sell alert
    const { sendNotification, calls } = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification });

    expect(alertRow(alertId).status).toBe('active');
    expect(eventRows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('never fires twice: a triggered alert is out of the scan on the next tick', async () => {
    addUser(1);
    addAlert(1, { side: 'sell', comparator: 'above', threshold: 100 });
    addOrder(FORGE, TRITANIUM, 105, false);
    const { sendNotification, calls } = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification });
    await runMarketAlertsTick(db as Db, { sendNotification });

    expect(calls).toHaveLength(1);
    expect(eventRows()).toHaveLength(1);
  });

  it('ignores triggered and disabled alerts even when the price still crosses', async () => {
    addUser(1);
    const triggeredId = addAlert(1, { status: 'triggered' });
    const disabledId = addAlert(1, { typeId: PYERITE, status: 'disabled' });
    addOrder(FORGE, TRITANIUM, 105, false);
    addOrder(FORGE, PYERITE, 105, false);
    const { sendNotification, calls } = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification });

    expect(calls).toHaveLength(0);
    expect(eventRows()).toHaveLength(0);
    expect(alertRow(triggeredId).status).toBe('triggered');
    expect(alertRow(disabledId).status).toBe('disabled');
  });

  it('scopes firing to the alert region and type only', async () => {
    addUser(1);
    const alertId = addAlert(1, { regionId: DOMAIN, side: 'sell', comparator: 'above', threshold: 100 });
    addOrder(FORGE, TRITANIUM, 500, false); // crossing, but in The Forge
    const { sendNotification, calls } = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification });

    expect(alertRow(alertId).status).toBe('active');
    expect(calls).toHaveLength(0);
  });
});

describe('runMarketAlertsTick delivery', () => {
  it('keeps the event with delivered_at NULL when the sender rejects', async () => {
    addUser(1);
    const alertId = addAlert(1, { side: 'sell', comparator: 'above', threshold: 100 });
    addOrder(FORGE, TRITANIUM, 105, false);
    const sendNotification: MarketAlertNotificationSender = async () => {
      throw new Error('platform offline');
    };
    await runMarketAlertsTick(db as Db, { sendNotification });

    expect(alertRow(alertId).status).toBe('triggered'); // the firing is durable
    expect(eventRows()).toHaveLength(1);
    expect(eventRows()[0]?.delivered_at).toBeNull();
  });

  it('bounds a hung sender: the tick completes with delivered_at NULL and the alert triggered', async () => {
    addUser(1);
    const alertId = addAlert(1, { side: 'sell', comparator: 'above', threshold: 100 });
    addOrder(FORGE, TRITANIUM, 105, false);
    // A sender that never settles stands in for a hung platform write.
    const sendNotification: MarketAlertNotificationSender = () => new Promise<void>(() => {});
    await runMarketAlertsTick(db as Db, { sendNotification, sendTimeoutMs: 10 });

    expect(alertRow(alertId).status).toBe('triggered'); // the firing is durable
    expect(eventRows()).toHaveLength(1);
    expect(eventRows()[0]?.delivered_at).toBeNull();
  });

  it('falls back to the outbound lane and leaves delivered_at NULL when the user has none', async () => {
    addUser(1); // no telegram_accounts/discord_sessions row: no lane at all
    const alertId = addAlert(1);
    addOrder(FORGE, TRITANIUM, 105, false);
    // No sendNotification dep: the default lane-based sender is exercised.
    await runMarketAlertsTick(db as Db);

    expect(alertRow(alertId).status).toBe('triggered');
    expect(eventRows()).toHaveLength(1);
    expect(eventRows()[0]?.delivered_at).toBeNull();
  });

  it('delivers one alert per user independently when a batch fires', async () => {
    addUser(1);
    addUser(2);
    addAlert(1, { side: 'sell', comparator: 'above', threshold: 100 });
    addAlert(2, { side: 'sell', comparator: 'below', threshold: 200 });
    addOrder(FORGE, TRITANIUM, 105, false);
    const { sendNotification, calls } = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification });

    expect(eventRows()).toHaveLength(2);
    expect(calls.map((call) => call.userId).sort()).toEqual([1, 2]);
    expect(eventRows().every((event) => event.delivered_at !== null)).toBe(true);
  });
});

describe('worker concurrency and shutdown', () => {
  // A sender parked on a gate stands in for a slow platform send: the first
  // tick blocks inside delivery until the test releases it.
  function makeGatedSender() {
    let signalEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sendNotification: MarketAlertNotificationSender = async () => {
      signalEntered();
      await gate;
    };
    return { sendNotification, entered, release };
  }

  it('serializes overlapping entry points: a second tick skips instead of double-firing', async () => {
    addUser(1);
    addAlert(1, { side: 'sell', comparator: 'above', threshold: 100 });
    addOrder(FORGE, TRITANIUM, 105, false);
    const gated = makeGatedSender();
    const first = runMarketAlertsTick(db as Db, { sendNotification: gated.sendNotification });
    await gated.entered;

    const second = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification: second.sendNotification });
    expect(second.calls).toHaveLength(0);

    gated.release();
    await first;
    expect(eventRows()).toHaveLength(1);
  });

  it('stopMarketAlertsWorker waits for the in-flight tick before returning', async () => {
    addUser(1);
    addAlert(1, { side: 'sell', comparator: 'above', threshold: 100 });
    addOrder(FORGE, TRITANIUM, 105, false);
    const gated = makeGatedSender();
    const first = runMarketAlertsTick(db as Db, { sendNotification: gated.sendNotification });
    await gated.entered;

    let stopped = false;
    const stopPromise = Promise.resolve(stopMarketAlertsWorker()).then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false); // a parked tick must hold the stop open

    gated.release();
    await first;
    await stopPromise;
    expect(stopped).toBe(true);
  });
});
