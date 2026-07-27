/**
 * Defensive clients for community-run EVE APIs: EVE Ref (industry cost),
 * zKillboard (pilot/corp/alliance stats) and MutaMarket (abyssal modules).
 *
 * Every call is bounded (timeout + retry budget from config.community, plus a
 * hard response-size cap), sends the operator-identifying User-Agent (the same
 * CCP contact rule ESI follows), and degrades to { ok: false, error } instead
 * of throwing: a community site being down must never fail a user turn.
 *
 * Payload shapes below were verified against live responses on 2026-07-27;
 * the test fixtures in community-tools.test.ts are cut from those captures.
 */

import { config } from '../config.js';
import { fetchRetrying } from '../eve/http.js';

export type CommunityResult<T> = { ok: true; data: T } | { ok: false; error: string };

// Community payloads are large (zkill stats ~65 KB, mutamarket ~200 KB per
// type); everything past this cap is a degraded or hostile upstream.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// Bounded TTL cache of NORMALIZED results only — raw upstream payloads are
// never retained. Failures are cached briefly too, so a dead upstream is not
// re-probed with the full retry budget on every call.
const CACHE_MAX_ENTRIES = 300;
const NEGATIVE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAtMs: number; value: unknown }>();

function cacheGet<T>(key: string): CommunityResult<T> | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAtMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as CommunityResult<T>;
}

function cachePut(key: string, value: unknown, ttlMs: number): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expiresAtMs: Date.now() + ttlMs, value });
}

export function resetCommunityCacheForTests(): void {
  cache.clear();
}

async function readJsonCapped(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('response too large');
  if (!response.body) return await response.json();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('response exceeded size cap');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(merged)) as unknown;
}

async function getJson(url: string): Promise<CommunityResult<unknown>> {
  try {
    const response = await fetchRetrying(
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': config.esi.userAgent,
        },
      },
      {
        maxAttempts: config.community.retryMaxAttempts,
        backoffMaxMs: config.community.backoffMaxMs,
        timeoutMs: config.community.timeoutMs,
      },
    );
    if (!response.ok) {
      return { ok: false, error: `upstream responded ${response.status}` };
    }
    return { ok: true, data: await readJsonCapped(response) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Fetch + normalize + cache the normalized result (positive and negative). */
async function cached<T>(
  key: string,
  ttlMs: number,
  url: string,
  normalize: (raw: unknown) => CommunityResult<T>,
): Promise<CommunityResult<T>> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const fetched = await getJson(url);
  const result: CommunityResult<T> = fetched.ok ? normalize(fetched.data) : fetched;
  cachePut(key, result, result.ok ? ttlMs : NEGATIVE_TTL_MS);
  return result;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// EVE Ref industry cost
// ---------------------------------------------------------------------------

export type IndustryCostRequest = {
  productId: number;
  runs: number;
  meLevel?: number | null;
  teLevel?: number | null;
};

function clampInt(value: number, min: number, max: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * Manufacturing cost breakdown from api.everef.net. The response is passed
 * through mostly as-is (materials, time, per-unit costs) — the agent reads it
 * as data, and EVE Ref versions its own schema. Measured payload ~4 KB.
 */
export async function fetchIndustryCost(request: IndustryCostRequest): Promise<CommunityResult<unknown>> {
  const runs = clampInt(request.runs, 1, 10_000);
  if (runs === null) return { ok: false, error: 'runs must be a finite number' };
  const params = new URLSearchParams({
    product_id: String(request.productId),
    runs: String(runs),
  });
  if (request.meLevel != null) {
    const me = clampInt(request.meLevel, 0, 10);
    if (me !== null) params.set('me', String(me));
  }
  if (request.teLevel != null) {
    const te = clampInt(request.teLevel, 0, 20);
    if (te !== null) params.set('te', String(te));
  }
  const url = `${config.community.everefBaseUrl}/v1/industry/cost?${params}`;
  // Costs move with adjusted prices (daily) — an hour of cache is safe.
  return cached(url, 60 * 60_000, url, (raw) => ({ ok: true, data: raw }));
}

// ---------------------------------------------------------------------------
// zKillboard entity stats
// ---------------------------------------------------------------------------

export type ZkillScope = 'character' | 'corporation' | 'alliance';

export type ZkillStats = {
  scope: ZkillScope;
  id: number;
  dangerRatio: number | null;
  gangRatio: number | null;
  shipsDestroyed: number | null;
  shipsLost: number | null;
  iskDestroyed: number | null;
  iskLost: number | null;
  soloKills: number | null;
  /** All-time favourite ships when the payload has them, else the recent-week list. */
  topShips: Array<{ shipTypeId: number; shipName: string | null; kills: number }>;
  /** Top-3 most active hours of day, UTC. */
  activeHoursUtc: number[];
};

function extractTopShips(raw: Record<string, unknown>): ZkillStats['topShips'] {
  const out: ZkillStats['topShips'] = [];
  // topAllTime: [{ type: 'ship', data: [{ shipTypeID, kills }] }] — all-time
  // favourites; topLists' shipType block is only the recent week.
  const allTime = Array.isArray(raw.topAllTime) ? raw.topAllTime : [];
  for (const list of allTime) {
    const entry = list as { type?: unknown; data?: unknown };
    if (entry.type !== 'ship' || !Array.isArray(entry.data)) continue;
    for (const value of entry.data.slice(0, 5)) {
      const row = value as { shipTypeID?: unknown; kills?: unknown; shipName?: unknown };
      const shipTypeId = asFiniteNumber(row.shipTypeID);
      const kills = asFiniteNumber(row.kills);
      if (shipTypeId !== null && kills !== null) {
        out.push({ shipTypeId, shipName: typeof row.shipName === 'string' ? row.shipName : null, kills });
      }
    }
  }
  if (out.length > 0) {
    out.sort((a, b) => b.kills - a.kills);
    return out.slice(0, 5);
  }
  const topLists = Array.isArray(raw.topLists) ? raw.topLists : [];
  for (const list of topLists) {
    const entry = list as { type?: unknown; values?: unknown };
    if (entry.type !== 'shipType' || !Array.isArray(entry.values)) continue;
    for (const value of entry.values.slice(0, 5)) {
      const row = value as { shipTypeID?: unknown; kills?: unknown; shipName?: unknown };
      const shipTypeId = asFiniteNumber(row.shipTypeID);
      const kills = asFiniteNumber(row.kills);
      if (shipTypeId !== null && kills !== null) {
        out.push({ shipTypeId, shipName: typeof row.shipName === 'string' ? row.shipName : null, kills });
      }
    }
  }
  return out.slice(0, 5);
}

function extractActiveHours(raw: Record<string, unknown>): number[] {
  // activity is keyed by DAY OF WEEK ("0".."6", plus "max"/"days"); each day
  // maps hour-of-day -> kills. Sum per hour ACROSS days to get hours of day.
  const activity = raw.activity as Record<string, unknown> | undefined;
  if (!activity || typeof activity !== 'object') return [];
  const hourTotals = new Map<number, number>();
  for (let day = 0; day < 7; day += 1) {
    const hours = activity[String(day)];
    if (!hours || typeof hours !== 'object') continue;
    for (const [hourKey, kills] of Object.entries(hours as Record<string, unknown>)) {
      const hour = Number(hourKey);
      const count = asFiniteNumber(kills);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || count === null) continue;
      hourTotals.set(hour, (hourTotals.get(hour) ?? 0) + count);
    }
  }
  return [...hourTotals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hour]) => hour);
}

/**
 * zKillboard /api/stats/. The upstream is strict about clients (silent empty
 * responses for impolite ones), so: identifying UA, long cache, and an
 * explicit "upstream returned nothing" error the model can relay honestly.
 */
export async function fetchZkillStats(scope: ZkillScope, id: number): Promise<CommunityResult<ZkillStats>> {
  const url = `${config.community.zkillBaseUrl}/api/stats/${scope}ID/${id}/`;
  return cached(`zkill:${scope}:${id}`, 30 * 60_000, url, (payload) => {
    const raw = payload as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
      return { ok: false, error: 'zKillboard returned an empty stats payload (rate-limited or unknown entity)' };
    }
    return {
      ok: true,
      data: {
        scope,
        id,
        dangerRatio: asFiniteNumber(raw.dangerRatio),
        gangRatio: asFiniteNumber(raw.gangRatio),
        shipsDestroyed: asFiniteNumber(raw.shipsDestroyed),
        shipsLost: asFiniteNumber(raw.shipsLost),
        iskDestroyed: asFiniteNumber(raw.iskDestroyed),
        iskLost: asFiniteNumber(raw.iskLost),
        soloKills: asFiniteNumber(raw.soloKills),
        topShips: extractTopShips(raw),
        activeHoursUtc: extractActiveHours(raw),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// MutaMarket abyssal modules
// ---------------------------------------------------------------------------

export type AbyssalListing = {
  itemId: number;
  typeName: string | null;
  /** Asking price from the attached contract; listings without one are skipped. */
  price: number;
  contractType: string | null;
  estimatedValue: number | null;
  attributes: Array<{ name: string; value: number; baseValue: number | null }>;
};

/**
 * MutaMarket listings for one abyssal base type. Mutated modules are unique
 * items with no ESI market presence at all — this is the only price source.
 * Live shape: rows carry `contract: { price, type } | null` and FLAT
 * `mutated_attributes: [{ name, display_name, value, base_value, ... }]`.
 * Rows without a contract are not for sale and are dropped; the rest are
 * returned cheapest-first.
 */
export async function fetchAbyssalListings(typeId: number): Promise<CommunityResult<AbyssalListing[]>> {
  const url = `${config.community.mutamarketBaseUrl}/api/modules/type/${typeId}`;
  return cached(`mutamarket:${typeId}`, 15 * 60_000, url, (payload) => {
    const rows = Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: unknown[] }).data
      : [];
    const listings: AbyssalListing[] = [];
    for (const row of rows) {
      const entry = row as Record<string, unknown>;
      const itemId = asFiniteNumber(entry.id);
      if (itemId === null) continue;
      const contract = entry.contract as { price?: unknown; type?: unknown } | null | undefined;
      const price = contract ? asFiniteNumber(contract.price) : null;
      if (price === null) continue; // not for sale
      const type = entry.type as { name?: unknown } | undefined;
      const attributes: AbyssalListing['attributes'] = [];
      const rawAttributes = Array.isArray(entry.mutated_attributes) ? entry.mutated_attributes : [];
      for (const attribute of rawAttributes.slice(0, 12)) {
        const attr = attribute as { name?: unknown; display_name?: unknown; value?: unknown; base_value?: unknown };
        const name = typeof attr.display_name === 'string'
          ? attr.display_name
          : typeof attr.name === 'string' ? attr.name : null;
        const value = asFiniteNumber(attr.value);
        if (name && value !== null) {
          attributes.push({ name, value, baseValue: asFiniteNumber(attr.base_value) });
        }
      }
      listings.push({
        itemId,
        typeName: type && typeof type.name === 'string' ? type.name : null,
        price,
        contractType: contract && typeof contract.type === 'string' ? contract.type : null,
        estimatedValue: asFiniteNumber(entry.estimated_value),
        attributes,
      });
    }
    listings.sort((a, b) => a.price - b.price);
    return { ok: true, data: listings.slice(0, 25) };
  });
}
