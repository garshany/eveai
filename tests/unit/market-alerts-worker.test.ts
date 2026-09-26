import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../../src/db/sqlite.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  runMarketAlertsTick,
  stopMarketAlertsWorker,
  type MarketAlertNotificationSender,
} from '../../src/eve/market-alerts-worker.js';
import { registerTelegramOutbound } from '../../src/messaging/outbound.js';

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
  registerTelegramOutbound(null);
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

describe('undelivered event redelivery', () => {
  function seedTriggeredEvent(options: { userId: number; hoursAgo?: number }): number {
    addUser(options.userId);
    const alertId = addAlert(options.userId, { status: 'triggered' });
    const result = db.prepare(`
      INSERT INTO market_alert_events (alert_id, user_id, type_id, price, threshold, triggered_at)
      VALUES (?, ?, ?, 120, 100, datetime('now', ?))
    `).run(alertId, options.userId, TRITANIUM, `-${options.hoursAgo ?? 1} hours`);
    return Number(result.lastInsertRowid);
  }

  it('redelivers a previously failed event on the next tick and marks it delivered', async () => {
    const eventId = seedTriggeredEvent({ userId: 7 });
    const sender = recordingSender();
    await runMarketAlertsTick(db, { sendNotification: sender.sendNotification });

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].userId).toBe(7);
    const row = eventRows().find((event) => event.event_id === eventId);
    expect(row?.delivered_at).not.toBeNull();
  });

  it('keeps the event pending when redelivery fails again', async () => {
    const eventId = seedTriggeredEvent({ userId: 7 });
    await runMarketAlertsTick(db, {
      sendNotification: async () => { throw new Error('lane down'); },
    });
    const row = eventRows().find((event) => event.event_id === eventId);
    expect(row?.delivered_at).toBeNull();
  });

  it('gives up on events older than the 24h window', async () => {
    seedTriggeredEvent({ userId: 7, hoursAgo: 30 });
    const sender = recordingSender();
    await runMarketAlertsTick(db, { sendNotification: sender.sendNotification });
    expect(sender.calls).toHaveLength(0);
  });

  it('never double-delivers an already delivered event', async () => {
    const eventId = seedTriggeredEvent({ userId: 7 });
    db.prepare("UPDATE market_alert_events SET delivered_at = datetime('now') WHERE event_id = ?").run(eventId);
    const sender = recordingSender();
    await runMarketAlertsTick(db, { sendNotification: sender.sendNotification });
    expect(sender.calls).toHaveLength(0);
  });
});

describe('redelivery backoff, terminal events and tick bounds', () => {
  function seedEvent(userId: number, options: { hoursAgo?: number; attempts?: number } = {}): number {
    if (!db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(userId)) addUser(userId);
    const alertId = addAlert(userId, { status: 'triggered' });
    const result = db.prepare(`
      INSERT INTO market_alert_events (alert_id, user_id, type_id, price, threshold, triggered_at, delivery_attempts)
      VALUES (?, ?, ?, 120, 100, datetime('now', ?), ?)
    `).run(alertId, userId, TRITANIUM, `-${options.hoursAgo ?? 1} hours`, options.attempts ?? 0);
    return Number(result.lastInsertRowid);
  }

  function deliveryState(eventId: number) {
    return db.prepare(`
      SELECT delivered_at, delivery_attempts, abandoned_at,
             next_attempt_at, next_attempt_at > datetime('now') AS backing_off
      FROM market_alert_events WHERE event_id = ?
    `).get(eventId) as {
      delivered_at: string | null;
      delivery_attempts: number;
      abandoned_at: string | null;
      next_attempt_at: string | null;
      backing_off: number | null;
    };
  }

  function linkTelegram(userId: number, telegramId: number) {
    db.prepare(`
      INSERT INTO telegram_accounts (telegram_user_id, user_id, username, first_name, created_at)
      VALUES (?, ?, '', '', datetime('now'))
    `).run(telegramId, userId);
  }

  it('marks events of users with no outbound lane terminal so they stop starving others', async () => {
    // Twenty older events whose owners have no lane at all, then one newer
    // event for a user with a live Telegram lane. Default sender throughout.
    const deadIds = Array.from({ length: 20 }, (_, i) => seedEvent(100 + i, { hoursAgo: 10 }));
    addUser(7);
    linkTelegram(7, 7007);
    const liveId = seedEvent(7, { hoursAgo: 1 });
    const sent: number[] = [];
    registerTelegramOutbound(async (chatId) => { sent.push(chatId); });

    await runMarketAlertsTick(db as Db);
    await runMarketAlertsTick(db as Db);

    expect(sent).toEqual([7007]);
    expect(deliveryState(liveId).delivered_at).not.toBeNull();
    for (const id of deadIds) {
      expect(deliveryState(id)).toMatchObject({ delivered_at: null, delivery_attempts: 1 });
      expect(deliveryState(id).abandoned_at).not.toBeNull();
    }
  });

  it('keeps a linked user whose platform sender is offline retryable (not terminal)', async () => {
    addUser(7);
    linkTelegram(7, 7007);
    const eventId = seedEvent(7);
    // No platform sender registered: the lane exists but the push cannot land.
    await runMarketAlertsTick(db as Db);
    expect(deliveryState(eventId)).toMatchObject({ delivered_at: null, delivery_attempts: 1, abandoned_at: null });
    expect(deliveryState(eventId).backing_off).toBe(1);
  });

  it('backs off a failing event instead of retrying it every tick', async () => {
    const eventId = seedEvent(7);
    let calls = 0;
    const failing: MarketAlertNotificationSender = async () => {
      calls += 1;
      throw new Error('platform offline');
    };
    await runMarketAlertsTick(db as Db, { sendNotification: failing });
    expect(calls).toBe(1);
    expect(deliveryState(eventId)).toMatchObject({ delivery_attempts: 1, abandoned_at: null, backing_off: 1 });

    await runMarketAlertsTick(db as Db, { sendNotification: failing });
    expect(calls).toBe(1); // still inside the backoff window

    db.prepare("UPDATE market_alert_events SET next_attempt_at = datetime('now', '-1 minute') WHERE event_id = ?").run(eventId);
    await runMarketAlertsTick(db as Db, { sendNotification: failing });
    expect(calls).toBe(2);
    expect(deliveryState(eventId).delivery_attempts).toBe(2);
    // Exponential: the second backoff is longer than the first (8 vs 4 min).
    const gap = db.prepare(
      "SELECT (julianday(next_attempt_at) - julianday('now')) * 24 * 60 AS minutes FROM market_alert_events WHERE event_id = ?",
    ).get(eventId) as { minutes: number };
    expect(gap.minutes).toBeGreaterThan(6);
    // Upper bound with tolerance: the gap is ~8 min, but julianday() difference
    // arithmetic carries floating-point error (e.g. 8.0000001), so a hard <= 8
    // flakes. 8.5 still sits well below the next (16 min) backoff step.
    expect(gap.minutes).toBeLessThanOrEqual(8.5);

    // An event that eventually delivers keeps the normal semantics.
    db.prepare("UPDATE market_alert_events SET next_attempt_at = datetime('now', '-1 minute') WHERE event_id = ?").run(eventId);
    const sender = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification: sender.sendNotification });
    expect(sender.calls).toHaveLength(1);
    expect(deliveryState(eventId).delivered_at).not.toBeNull();
  });

  it('abandons an event after the max attempts cap', async () => {
    const eventId = seedEvent(7, { attempts: 7 });
    await runMarketAlertsTick(db as Db, {
      sendNotification: async () => { throw new Error('platform offline'); },
    });
    expect(deliveryState(eventId).delivery_attempts).toBe(8);
    expect(deliveryState(eventId).abandoned_at).not.toBeNull();

    const sender = recordingSender();
    await runMarketAlertsTick(db as Db, { sendNotification: sender.sendNotification });
    expect(sender.calls).toHaveLength(0);
  });

  it('does not let twenty failing older events starve a newer deliverable one', async () => {
    for (let i = 0; i < 20; i += 1) seedEvent(100 + i, { hoursAgo: 10 });
    const liveId = seedEvent(7, { hoursAgo: 1 });
    const sendNotification: MarketAlertNotificationSender = async (userId) => {
      if (userId !== 7) throw new Error('platform offline');
    };
    await runMarketAlertsTick(db as Db, { sendNotification });
    await runMarketAlertsTick(db as Db, { sendNotification });
    expect(deliveryState(liveId).delivered_at).not.toBeNull();
  });

  it('bounds the time one tick spends on redelivery', async () => {
    for (let i = 0; i < 20; i += 1) seedEvent(100 + i);
    let calls = 0;
    const hung: MarketAlertNotificationSender = () => {
      calls += 1;
      return new Promise<void>(() => {});
    };
    const started = Date.now();
    await runMarketAlertsTick(db as Db, {
      sendNotification: hung,
      sendTimeoutMs: 50,
      deliveryConcurrency: 2,
      deliveryBudgetMs: 120,
    });
    const elapsed = Date.now() - started;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(20);
    expect(elapsed).toBeLessThan(600);
    // Events never attempted this tick stay pending with no attempt recorded.
    const untouched = db.prepare(
      'SELECT COUNT(*) AS n FROM market_alert_events WHERE delivery_attempts = 0 AND delivered_at IS NULL',
    ).get() as { n: number };
    expect(untouched.n).toBe(20 - calls);
  });
});
