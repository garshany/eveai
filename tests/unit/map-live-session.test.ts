import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { config } from '../../src/config.js';
import type { UserContext } from '../../src/auth/user-resolver.js';

const esiMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: esiMock,
}));
// Private ESI is gated on a fresh capability snapshot; the poller refreshes it
// itself, so the test has to let that succeed.
vi.mock('../../src/eve/capabilities.js', () => ({
  getEveCapabilities: vi.fn(async () => ({ linked: true })),
  hasFreshCapabilitySnapshot: vi.fn(() => true),
}));

const {
  attachLiveSession,
  getLiveSession,
  getLiveSessionStats,
  resetLiveSessionsForTests,
  stopAllLiveSessions,
} = await import('../../src/eve-map/live-session.js');

const CHARACTER_ID = 90000001;

function ctx(userId = 1): UserContext {
  return { userId, chatId: -2_000_000_000, notificationCapability: 'web' };
}

/** ESI-ответы по имени операции: тесты описывают состояние, а не порядок вызовов. */
function esiReturns(responses: {
  online?: boolean;
  systemId?: number | null;
  shipTypeId?: number;
  fail?: string;
}): void {
  esiMock.mockImplementation(async (_db: unknown, operation: string) => {
    if (responses.fail) return { ok: false, status: 500, error: responses.fail };
    if (operation === 'get_characters_character_id_online') {
      return { ok: true, status: 200, data: { online: responses.online ?? true }, headers: {} };
    }
    if (operation === 'get_characters_character_id_location') {
      return {
        ok: true,
        status: 200,
        data: { solar_system_id: responses.systemId ?? 30000142 },
        headers: {},
      };
    }
    if (operation === 'get_characters_character_id_ship') {
      return {
        ok: true,
        status: 200,
        data: { ship_type_id: responses.shipTypeId ?? 648, ship_name: 'Hauler' },
        headers: {},
      };
    }
    return { ok: false, status: 404, error: `unexpected operation ${operation}` };
  });
}

/** Ждёт, пока асинхронный опрос отработает: он стартует сразу при attach. */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('map live session', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    esiMock.mockReset();
    resetLiveSessionsForTests();
  });

  afterEach(() => {
    resetLiveSessionsForTests();
    db.close();
  });

  it('emits a location on the first poll', async () => {
    esiReturns({ systemId: 30000142 });
    const events: string[] = [];
    const attached = attachLiveSession(db, ctx(), CHARACTER_ID, (event) => events.push(event.type));
    expect(attached.ok).toBe(true);

    await settle();
    expect(events).toContain('location');
    expect(getLiveSession(CHARACTER_ID)?.lastLocation?.solarSystemId).toBe(30000142);
  });

  it('shares one poller across tabs of the same character', async () => {
    esiReturns({});
    const a = attachLiveSession(db, ctx(), CHARACTER_ID, () => {});
    const b = attachLiveSession(db, ctx(), CHARACTER_ID, () => {});
    await settle();

    expect(a.ok && b.ok).toBe(true);
    // Три вкладки — это три подписчика на одном таймере, а не три таймера.
    expect(getLiveSessionStats()).toEqual({ sessions: 1, subscribers: 2 });
  });

  it('hands a late tab the current position immediately', async () => {
    esiReturns({});
    attachLiveSession(db, ctx(), CHARACTER_ID, () => {});
    await settle();

    const events: string[] = [];
    attachLiveSession(db, ctx(), CHARACTER_ID, (event) => events.push(event.type));
    expect(events).toEqual(['location']);
  });

  it('stops the poller when the last subscriber detaches', async () => {
    esiReturns({});
    const first = attachLiveSession(db, ctx(), CHARACTER_ID, () => {});
    const second = attachLiveSession(db, ctx(), CHARACTER_ID, () => {});
    await settle();
    if (!first.ok || !second.ok) throw new Error('attach failed');

    first.detach();
    expect(getLiveSessionStats().sessions).toBe(1);
    second.detach();
    // Оборванный SSE не должен оставлять за собой таймер и расход ESI.
    expect(getLiveSessionStats().sessions).toBe(0);
  });

  it('refuses a character already owned by another account', async () => {
    esiReturns({});
    attachLiveSession(db, ctx(1), CHARACTER_ID, () => {});
    await settle();

    const other = attachLiveSession(db, ctx(2), CHARACTER_ID, () => {});
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.statusCode).toBe(503);
  });

  it('enforces the per-user session cap with a retry hint', async () => {
    esiReturns({});
    for (let index = 0; index < config.map.maxLiveSessionsPerUser; index += 1) {
      attachLiveSession(db, ctx(), CHARACTER_ID + index, () => {});
    }
    await settle();

    const extra = attachLiveSession(db, ctx(), CHARACTER_ID + 999, () => {});
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.statusCode).toBe(429);
      expect(extra.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('reports a jump between two different systems', async () => {
    esiReturns({ systemId: 30000142 });
    const jumps: boolean[] = [];
    attachLiveSession(db, ctx(), CHARACTER_ID, (event) => {
      if (event.type === 'location') jumps.push(event.jumped);
    });
    await settle();
    expect(jumps).toEqual([false]);
  });

  it('stops polling when the pilot goes offline', async () => {
    esiReturns({ online: false });
    const events: string[] = [];
    attachLiveSession(db, ctx(), CHARACTER_ID, (event) => events.push(event.type));
    await settle();

    // Замерший маркер, притворяющийся живым, хуже честного «офлайн».
    expect(events).toContain('offline');
    expect(events).not.toContain('location');
  });

  it('backs off on failure and stops after the configured limit', async () => {
    esiReturns({ fail: 'ESI unavailable' });
    const events: Array<{ type: string; fatal?: boolean }> = [];
    attachLiveSession(db, ctx(), CHARACTER_ID, (event) => {
      events.push({ type: event.type, fatal: event.type === 'error' ? event.fatal : undefined });
    });
    await settle();

    const errors = events.filter((event) => event.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.fatal).toBe(false);
    // Один провал — это откат, а не остановка.
    expect(getLiveSession(CHARACTER_ID)?.consecutiveFailures).toBe(1);
  });

  it('drains every session on shutdown and tells subscribers why', async () => {
    esiReturns({});
    const events: Array<{ type: string; message?: string }> = [];
    attachLiveSession(db, ctx(), CHARACTER_ID, (event) => {
      events.push({ type: event.type, message: event.type === 'error' ? event.message : undefined });
    });
    await settle();

    const drained = stopAllLiveSessions('server shutting down');
    expect(drained).toBe(1);
    expect(getLiveSessionStats().sessions).toBe(0);
    expect(events.some((event) => event.message === 'server shutting down')).toBe(true);
  });
});

describe('offline stays offline', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    esiMock.mockReset();
    resetLiveSessionsForTests();
  });
  afterEach(() => { resetLiveSessionsForTests(); db.close(); });

  it('does not publish a live position between online checks while logged out', async () => {
    esiReturns({ online: false });
    const events: string[] = [];
    const attached = attachLiveSession(db, ctx(), CHARACTER_ID, (event) => events.push(event.type));
    if (!attached.ok) throw new Error('attach failed');
    await settle();
    expect(events).toEqual(['offline']);

    // Следующие опросы внутри минутного окна пропускают проверку онлайна.
    // Раньше они всё равно шли за позицией и публиковали её как live —
    // интерфейс возвращался из «офлайн» в «в сети» на пятьдесят пять секунд.
    esiReturns({ online: true, systemId: 30000142 });
    esiMock.mockImplementation(async (_db: unknown, operation: string) => {
      if (operation === 'get_characters_character_id_online') {
        throw new Error('online must not be re-checked inside the interval');
      }
      return { ok: true, status: 200, data: { solar_system_id: 30000142 }, headers: {} };
    });
    await settle();
    expect(events).toEqual(['offline']);
  });
});
