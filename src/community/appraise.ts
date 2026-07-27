/**
 * Cargo/loot appraisal for pasted item lists.
 *
 * Primary path is fully local: names resolve against sde_types and prices come
 * from the local market snapshot (best regional sell/buy), so the tool works
 * even with every third-party site down. When a Janice API key is configured
 * and the requested region is The Forge (Janice prices Jita), its appraisal is
 * attached as a second opinion — never as the product.
 */

import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { fetchRetrying } from '../eve/http.js';

export type ParsedLine = { name: string; quantity: number };

export type AppraisedItem = {
  typeId: number;
  name: string;
  quantity: number;
  bestSell: number | null;
  bestBuy: number | null;
  sellTotal: number | null;
  buyTotal: number | null;
};

export type AppraisalResult = {
  regionId: number;
  items: AppraisedItem[];
  unresolved: string[];
  totals: { sell: number; buy: number; itemsPriced: number; itemsTotal: number };
  janice: { totalSellIsk: number; totalBuyIsk: number; url: string | null } | null;
};

const MAX_LINES = 200;
const JITA_REGION_ID = 10000002;

/**
 * Inventory quantities are integers. Accepts plain digits and
 * thousands-grouped digits ("1 200", "1,200", "1.200"); anything else —
 * including real fractions like "1.5" — is NOT a quantity (it is usually the
 * volume column) and returns null so the caller falls back to 1 instead of
 * silently multiplying the appraisal tenfold.
 */
function parseQuantity(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (/^\d{1,3}([ .,]\d{3})+$/.test(trimmed)) {
    const value = Number(trimmed.replace(/[ .,]/g, ''));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  return null;
}

/**
 * Accepts the formats players actually paste:
 * - inventory copies "Name<TAB>Qty<TAB>…" (empty cells preserved, so a blank
 *   quantity column never lets the volume column masquerade as a quantity);
 * - "Name x3" / "3x Name" / "1200 Name" / trailing "Name 3";
 * - bare names (quantity 1).
 * Duplicate names merge case-insensitively; the original casing is kept for
 * SDE resolution. Unresolvable lines are reported back, never dropped.
 */
export function parseItemLines(text: string): ParsedLine[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, MAX_LINES);
  const byKey = new Map<string, ParsedLine>();

  const add = (name: string, quantity: number): void => {
    const cleaned = name.trim();
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += Math.max(1, quantity);
    } else {
      byKey.set(key, { name: cleaned, quantity: Math.max(1, quantity) });
    }
  };

  for (const line of lines) {
    // Inventory copy: columns are positional; do NOT drop empty cells, or the
    // volume column shifts into the quantity slot.
    if (line.includes('\t')) {
      const parts = line.split('\t');
      const name = parts[0].trim();
      const qty = parts.length > 1 ? parseQuantity(parts[1]) : null;
      add(name, qty ?? 1);
      continue;
    }

    // "3x Rifter" / "3 x Rifter"
    const leadingX = line.match(/^(\d[\d\s.,]*?)\s*[xX]\s+(.+)$/);
    if (leadingX) {
      const qty = parseQuantity(leadingX[1]);
      if (qty !== null) {
        add(leadingX[2], qty);
        continue;
      }
    }

    // "1200 Tritanium"
    const leadingQty = line.match(/^(\d[\d\s.,]*)\s+(\D.*)$/);
    if (leadingQty) {
      const qty = parseQuantity(leadingQty[1]);
      if (qty !== null) {
        add(leadingQty[2], qty);
        continue;
      }
    }

    // "Rifter x3"
    const trailingX = line.match(/^(.+?)\s+[xX]\s?(\d[\d\s.,]*)$/);
    if (trailingX) {
      const qty = parseQuantity(trailingX[2]);
      if (qty !== null) {
        add(trailingX[1], qty);
        continue;
      }
    }

    // "Warp Scrambler II 2" — trailing bare integer, but only when the name
    // part does not itself end with a digit (protects "Item Mk2 5" names).
    const trailing = line.match(/^(.+?)\s+(\d[\d\s.,]*)$/);
    if (trailing && !/\d$/.test(trailing[1].trim())) {
      const qty = parseQuantity(trailing[2]);
      if (qty !== null) {
        add(trailing[1], qty);
        continue;
      }
    }

    add(line, 1);
  }
  return [...byKey.values()];
}

/**
 * Local pricing against the market snapshot for one region (default Jita's
 * Forge). Name resolution uses the (name COLLATE NOCASE) index — a LOWER()
 * wrapper would force a full scan of sde_types on every line and block the
 * event loop — and prefers published types, mirroring searchMarketTypes.
 */
export function appraiseLocally(db: Db, parsed: ParsedLine[], regionId: number): Omit<AppraisalResult, 'janice'> {
  const resolveStmt = db.prepare(`
    SELECT type_id, name FROM sde_types
    WHERE name = ? COLLATE NOCASE
    ORDER BY (json_extract(data_json, '$.published') = 1) DESC
    LIMIT 1
  `);
  const priceStmt = db.prepare(`
    SELECT
      (SELECT MIN(price) FROM market_orders WHERE type_id = ? AND region_id = ? AND is_buy_order = 0) AS best_sell,
      (SELECT MAX(price) FROM market_orders WHERE type_id = ? AND region_id = ? AND is_buy_order = 1) AS best_buy
  `);

  const items: AppraisedItem[] = [];
  const unresolved: string[] = [];
  let sellTotal = 0;
  let buyTotal = 0;
  let itemsPriced = 0;

  for (const line of parsed) {
    const type = resolveStmt.get(line.name) as { type_id: number; name: string } | undefined;
    if (!type) {
      unresolved.push(line.name);
      continue;
    }
    const price = priceStmt.get(type.type_id, regionId, type.type_id, regionId) as
      { best_sell: number | null; best_buy: number | null };
    const bestSell = price.best_sell;
    const bestBuy = price.best_buy;
    const item: AppraisedItem = {
      typeId: type.type_id,
      name: type.name,
      quantity: line.quantity,
      bestSell,
      bestBuy,
      sellTotal: bestSell !== null ? bestSell * line.quantity : null,
      buyTotal: bestBuy !== null ? bestBuy * line.quantity : null,
    };
    if (item.sellTotal !== null) {
      sellTotal += item.sellTotal;
      itemsPriced += 1;
    }
    if (item.buyTotal !== null) buyTotal += item.buyTotal;
    items.push(item);
  }

  return {
    regionId,
    items,
    unresolved,
    totals: { sell: sellTotal, buy: buyTotal, itemsPriced, itemsTotal: parsed.length },
  };
}

/**
 * Optional Janice second opinion. Only attached when the local appraisal is
 * for The Forge — Janice prices Jita, and mixing two different markets in one
 * answer would be quietly wrong. persist=false: a pasted cargo list is the
 * user's private data and must not be stored on a third-party server.
 */
export async function fetchJaniceAppraisal(rawText: string, regionId: number): Promise<AppraisalResult['janice']> {
  const apiKey = config.community.janiceApiKey;
  if (!apiKey || regionId !== JITA_REGION_ID) return null;
  try {
    const response = await fetchRetrying(
      `${config.community.janiceBaseUrl}/api/rest/v2/appraisal?market=2&persist=false&compactize=true`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'X-ApiKey': apiKey,
          'User-Agent': config.esi.userAgent,
        },
        body: rawText.slice(0, 20_000),
      },
      {
        maxAttempts: config.community.retryMaxAttempts,
        backoffMaxMs: config.community.backoffMaxMs,
        timeoutMs: config.community.timeoutMs,
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      code?: unknown;
      immediatePrices?: { totalSellPrice?: unknown; totalBuyPrice?: unknown };
    };
    const sell = body.immediatePrices?.totalSellPrice;
    const buy = body.immediatePrices?.totalBuyPrice;
    if (typeof sell !== 'number' || typeof buy !== 'number') return null;
    return {
      totalSellIsk: sell,
      totalBuyIsk: buy,
      url: typeof body.code === 'string' ? `${config.community.janiceBaseUrl}/a/${body.code}` : null,
    };
  } catch {
    return null;
  }
}
