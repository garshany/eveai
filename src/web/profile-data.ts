import type { Db } from '../db/sqlite.js';
import { EVE_ACCESS_GROUPS, EVE_ACCESS_GROUP_IDS, type EveAccessGroupId } from '../eve/scopes.js';
import {
  characterDatasetRequirements,
  getCharacterDatasetStatuses,
} from '../eve/character-sync.js';

/**
 * Read models for the web "living profile": pure SQLite projections of the
 * materialized character datastore (character_* tables) enriched with SDE
 * names and valuations from the local market_orders snapshot. No ESI calls
 * happen here — freshness is reported by the routes from character_sync_state
 * and refresh is a separate explicit action.
 */

// EVE location ids at or above this value are player structures; their names
// require the (often missing) structure scopes, so they stay generic.
const STRUCTURE_LOCATION_ID_THRESHOLD = 1_000_000_000_000;
const MAX_CONTAINER_HOPS = 10;

export type AssetLocationValuation = 'complete' | 'partial' | 'unavailable';

export type AssetLocation = {
  locationId: number;
  kind: 'station' | 'structure' | 'other';
  name: string | null;
  solarSystemName: string | null;
  regionId: number | null;
  regionName: string | null;
  itemCount: number;
  totalQuantity: number;
  totalVolume: number;
  estimatedValue: number | null;
  valuation: AssetLocationValuation;
};

export type AssetItem = {
  itemId: number;
  typeId: number;
  typeName: string | null;
  groupName: string | null;
  quantity: number;
  unitVolume: number | null;
  totalVolume: number | null;
  unitPrice: number | null;
  totalValue: number | null;
  isBlueprintCopy: boolean;
};

export type CharacterOrder = {
  orderId: number;
  typeId: number;
  typeName: string | null;
  regionId: number | null;
  regionName: string | null;
  locationId: number | null;
  locationKind: 'station' | 'structure' | 'other' | null;
  locationName: string | null;
  isBuyOrder: boolean;
  price: number | null;
  volumeRemain: number | null;
  volumeTotal: number | null;
  issued: string | null;
};

export type OrderTotals = {
  sellCount: number;
  sellTotal: number;
  buyCount: number;
  buyTotal: number;
  escrowTotal: number;
};

export type WalletJournalDay = {
  date: string;
  delta: number;
  balance: number | null;
};

export type WalletSummary = {
  balance: number | null;
  journal: WalletJournalDay[];
};

export type Implant = {
  typeId: number;
  typeName: string | null;
};

export type ClonesSummary = {
  home: { locationId: number; locationName: string | null } | null;
  jumpClones: Array<{
    jumpCloneId: number;
    name: string | null;
    locationId: number | null;
    locationName: string | null;
    implants: Implant[];
  }>;
  currentImplants: Implant[];
};

export type SkillsSummary = {
  totalSp: number | null;
  unallocatedSp: number | null;
  queue: Array<{
    queuePosition: number;
    skillId: number | null;
    skillName: string | null;
    finishedLevel: number | null;
    startDate: string | null;
    finishDate: string | null;
  }>;
};

export type AccessSummary = {
  scopes: string[];
  groups: Array<{
    id: EveAccessGroupId;
    label: string;
    granted: string[];
    missing: string[];
  }>;
  datasets: Array<{
    dataset: string;
    status: string;
    syncedAt: string | null;
    expiresAt: string | null;
    error: string | null;
    requiredScopes: string[];
  }>;
};

const ACCESS_GROUP_LABELS: Record<EveAccessGroupId, string> = {
  navigation: 'Навигация',
  character: 'Персонаж',
  economy: 'Экономика',
  communications: 'Коммуникации',
  corporation: 'Корпорация',
  actions: 'Действия',
};

type LocationInfo = {
  kind: 'station' | 'structure' | 'other';
  name: string | null;
  solarSystemName: string | null;
  regionId: number | null;
  regionName: string | null;
};

/**
 * Root-location resolution in SQL. Items inside containers/ships carry
 * location_type='item' and their location_id is the container's item_id; the
 * recursive walk climbs that chain (bounded) so everything aggregates under
 * the station or structure that ultimately holds it. A broken chain keeps its
 * last known location_id as the root. Doing this in SQL keeps 40k-item
 * hangars out of JS parameter lists (SQLite caps variables at 32766).
 */
const ROOT_LOCATION_CTE = `
WITH RECURSIVE
walk(item_id, root_location_id, location_type, hops) AS (
  SELECT a.item_id, a.location_id, a.location_type, 0
  FROM character_assets a
  WHERE a.character_id = ?
  UNION ALL
  SELECT walk.item_id, parent.location_id, parent.location_type, walk.hops + 1
  FROM walk
  JOIN character_assets parent
    ON parent.character_id = ? AND parent.item_id = walk.root_location_id
  WHERE walk.location_type = 'item' AND walk.hops < ${MAX_CONTAINER_HOPS}
),
roots AS (
  SELECT item_id, root_location_id
  FROM (
    SELECT item_id, root_location_id, hops,
           MAX(hops) OVER (PARTITION BY item_id) AS max_hops
    FROM walk
  )
  WHERE hops = max_hops
)
`;

/**
 * Generic labels stay out of the payload: structures resolve to name=null
 * with kind='structure' (the client localizes the caption), an id matching a
 * solar system resolves to that system and its region (assets in space get a
 * regional valuation), anything else is an honest unknown 'other'.
 */
function resolveLocationInfo(db: Db, locationId: number): LocationInfo {
  if (locationId >= STRUCTURE_LOCATION_ID_THRESHOLD) {
    return {
      kind: 'structure',
      name: null,
      solarSystemName: null,
      regionId: null,
      regionName: null,
    };
  }
  const station = db.prepare(`
    SELECT
      st.name AS station_name,
      s.name AS system_name,
      r.region_id AS region_id,
      r.name AS region_name
    FROM sde_stations st
    LEFT JOIN sde_systems s ON s.system_id = st.system_id
    LEFT JOIN sde_constellations c ON c.constellation_id = s.constellation_id
    LEFT JOIN sde_regions r ON r.region_id = c.region_id
    WHERE st.station_id = ?
  `).get(locationId) as {
    station_name: string;
    system_name: string | null;
    region_id: number | null;
    region_name: string | null;
  } | undefined;
  if (station) {
    return {
      kind: 'station',
      name: station.station_name,
      solarSystemName: station.system_name,
      regionId: station.region_id,
      regionName: station.region_name,
    };
  }
  const system = db.prepare(`
    SELECT
      s.name AS system_name,
      r.region_id AS region_id,
      r.name AS region_name
    FROM sde_systems s
    LEFT JOIN sde_constellations c ON c.constellation_id = s.constellation_id
    LEFT JOIN sde_regions r ON r.region_id = c.region_id
    WHERE s.system_id = ?
  `).get(locationId) as {
    system_name: string;
    region_id: number | null;
    region_name: string | null;
  } | undefined;
  if (system) {
    return {
      kind: 'other',
      name: null,
      solarSystemName: system.system_name,
      regionId: system.region_id,
      regionName: system.region_name,
    };
  }
  return { kind: 'other', name: null, solarSystemName: null, regionId: null, regionName: null };
}

function loadTypeNames(db: Db, typeIds: readonly number[]): Map<number, string> {
  const names = new Map<number, string>();
  if (typeIds.length === 0) return names;
  const placeholders = typeIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT type_id, name FROM sde_types WHERE type_id IN (${placeholders})
  `).all(...typeIds) as Array<{ type_id: number; name: string }>;
  for (const row of rows) names.set(row.type_id, row.name);
  return names;
}

type LocationGroupRow = {
  location_id: number;
  item_count: number;
  total_quantity: number;
  total_volume: number;
  total_types: number | null;
  valued_types: number | null;
  value: number | null;
  total: number;
};

function toAssetLocation(db: Db, row: LocationGroupRow): AssetLocation {
  const info = resolveLocationInfo(db, row.location_id);
  const totalTypes = row.total_types ?? 0;
  const valuedTypes = row.valued_types ?? 0;
  let estimatedValue: number | null = null;
  let valuation: AssetLocationValuation = 'unavailable';
  if (row.value !== null && valuedTypes > 0) {
    estimatedValue = row.value;
    valuation = valuedTypes === totalTypes ? 'complete' : 'partial';
  }
  return {
    locationId: row.location_id,
    kind: info.kind,
    name: info.name,
    solarSystemName: info.solarSystemName,
    regionId: info.regionId,
    regionName: info.regionName,
    itemCount: row.item_count,
    totalQuantity: row.total_quantity,
    totalVolume: row.total_volume,
    estimatedValue,
    valuation,
  };
}

/**
 * Location rollup fully in SQL: grouping, volume/quantity sums and the
 * regional best-sell valuation are aggregated by SQLite, the page comes back
 * via LIMIT/OFFSET (COUNT(*) OVER() carries the pre-limit total). Blueprint
 * copies are excluded from the valuation basis — a copy is not worth the
 * original's sell price; they still count toward item/quantity/volume sums.
 */
const LOCATION_GROUPS_SQL = `
${ROOT_LOCATION_CTE},
loc AS (
  SELECT r.root_location_id AS location_id,
         COUNT(*) AS item_count,
         COALESCE(SUM(COALESCE(a.quantity, 0)), 0) AS total_quantity,
         COALESCE(SUM(
           COALESCE(json_extract(t.data_json, '$.volume'), 0) * COALESCE(a.quantity, 0)
         ), 0) AS total_volume
  FROM character_assets a
  JOIN roots r ON r.item_id = a.item_id
  LEFT JOIN sde_types t ON t.type_id = a.type_id
  WHERE a.character_id = ?
  GROUP BY r.root_location_id
),
regions AS (
  SELECT loc.location_id,
         COALESCE(by_station.region_id, by_system.region_id) AS region_id
  FROM loc
  LEFT JOIN (
    SELECT st.station_id AS location_id, c.region_id AS region_id
    FROM sde_stations st
    JOIN sde_systems s ON s.system_id = st.system_id
    JOIN sde_constellations c ON c.constellation_id = s.constellation_id
  ) by_station ON by_station.location_id = loc.location_id
  LEFT JOIN (
    SELECT s.system_id AS location_id, c.region_id AS region_id
    FROM sde_systems s
    JOIN sde_constellations c ON c.constellation_id = s.constellation_id
  ) by_system ON by_system.location_id = loc.location_id
),
typeqty AS (
  SELECT r.root_location_id AS location_id, a.type_id,
         SUM(COALESCE(a.quantity, 0)) AS quantity
  FROM character_assets a
  JOIN roots r ON r.item_id = a.item_id
  WHERE a.character_id = ? AND COALESCE(a.is_blueprint_copy, 0) = 0
  GROUP BY r.root_location_id, a.type_id
),
val AS (
  SELECT location_id,
         COUNT(*) AS total_types,
         COUNT(best_sell) AS valued_types,
         SUM(quantity * best_sell) AS value
  FROM (
    SELECT tq.location_id AS location_id, tq.quantity AS quantity,
           (SELECT MIN(o.price) FROM market_orders o
            WHERE o.type_id = tq.type_id AND o.region_id = rg.region_id
              AND o.is_buy_order = 0) AS best_sell
    FROM typeqty tq
    LEFT JOIN regions rg ON rg.location_id = tq.location_id
  )
  GROUP BY location_id
)
SELECT loc.location_id, loc.item_count, loc.total_quantity, loc.total_volume,
       val.total_types, val.valued_types, val.value,
       COUNT(*) OVER () AS total
FROM loc
LEFT JOIN val ON val.location_id = loc.location_id
ORDER BY (val.value IS NULL), val.value DESC, loc.item_count DESC, loc.location_id ASC
LIMIT ? OFFSET ?
`;

const LOCATION_GROUPS_COUNT_SQL = `
${ROOT_LOCATION_CTE}
SELECT COUNT(DISTINCT r.root_location_id) AS count
FROM character_assets a
JOIN roots r ON r.item_id = a.item_id
WHERE a.character_id = ?
`;

export function assetLocations(
  db: Db,
  characterId: number,
  limit: number,
  offset: number,
): { locations: AssetLocation[]; total: number } {
  // The recursive character filter appears in every CTE arm above.
  const params = [characterId, characterId, characterId, characterId, limit, offset];
  const rows = db.prepare(LOCATION_GROUPS_SQL).all(...params) as LocationGroupRow[];
  let total = rows[0]?.total ?? 0;
  if (rows.length === 0 && offset > 0) {
    // An out-of-range page yields no window row to carry the total.
    total = (db.prepare(LOCATION_GROUPS_COUNT_SQL)
      .get(characterId, characterId, characterId) as { count: number }).count;
  }
  return { locations: rows.map((row) => toAssetLocation(db, row)), total };
}

export function locationItems(
  db: Db,
  characterId: number,
  locationId: number,
  limit: number,
  offset: number,
): { items: AssetItem[]; total: number } {
  // Best sell is regional: locations without a known region (structures,
  // unrecognized ids) price every item as null. Blueprint copies are priced
  // null too — a copy is not worth the original's sell price (the UI shows
  // the copy badge instead).
  const regionId = resolveLocationInfo(db, locationId).regionId;

  const itemRows = db.prepare(`
    ${ROOT_LOCATION_CTE}
    SELECT
      item_id, type_id, quantity, is_blueprint_copy, type_name, group_name,
      unit_volume, unit_price,
      (unit_price * COALESCE(quantity, 0)) AS total_value,
      COUNT(*) OVER () AS total
    FROM (
      SELECT
        a.item_id AS item_id,
        a.type_id AS type_id,
        a.quantity AS quantity,
        a.is_blueprint_copy AS is_blueprint_copy,
        t.name AS type_name,
        g.name AS group_name,
        json_extract(t.data_json, '$.volume') AS unit_volume,
        CASE WHEN COALESCE(a.is_blueprint_copy, 0) = 1 THEN NULL
             ELSE (SELECT MIN(o.price) FROM market_orders o
                   WHERE o.type_id = a.type_id AND o.region_id = ? AND o.is_buy_order = 0)
        END AS unit_price
      FROM character_assets a
      JOIN roots r ON r.item_id = a.item_id
      LEFT JOIN sde_types t ON t.type_id = a.type_id
      LEFT JOIN sde_groups g ON g.group_id = t.group_id
      WHERE a.character_id = ? AND r.root_location_id = ?
    )
    ORDER BY total_value DESC, COALESCE(quantity, 0) DESC, item_id ASC
    LIMIT ? OFFSET ?
  `).all(characterId, characterId, regionId, characterId, locationId, limit, offset) as Array<{
    item_id: number;
    type_id: number;
    quantity: number | null;
    is_blueprint_copy: number;
    type_name: string | null;
    group_name: string | null;
    unit_volume: number | null;
    unit_price: number | null;
    total: number;
  }>;

  let total = itemRows[0]?.total ?? 0;
  if (itemRows.length === 0) {
    // Empty page (empty location or out-of-range offset): count in SQL.
    total = (db.prepare(`
      ${ROOT_LOCATION_CTE}
      SELECT COUNT(*) AS count
      FROM character_assets a
      JOIN roots r ON r.item_id = a.item_id
      WHERE a.character_id = ? AND r.root_location_id = ?
    `).get(characterId, characterId, characterId, locationId) as { count: number }).count;
  }

  return {
    total,
    items: itemRows.map((row) => ({
      itemId: row.item_id,
      typeId: row.type_id,
      typeName: row.type_name,
      groupName: row.group_name,
      quantity: row.quantity ?? 0,
      unitVolume: row.unit_volume,
      totalVolume: row.unit_volume === null ? null : row.unit_volume * (row.quantity ?? 0),
      unitPrice: row.unit_price,
      totalValue: row.unit_price === null ? null : row.unit_price * (row.quantity ?? 0),
      isBlueprintCopy: row.is_blueprint_copy === 1,
    })),
  };
}

export function activeOrders(
  db: Db,
  characterId: number,
  limit: number,
  offset: number,
): { orders: CharacterOrder[]; total: number; totals: OrderTotals } {
  const total = (db.prepare(
    'SELECT COUNT(*) AS count FROM character_orders WHERE character_id = ?',
  ).get(characterId) as { count: number }).count;

  const orderRows = db.prepare(`
    SELECT
      o.order_id AS order_id,
      o.type_id AS type_id,
      t.name AS type_name,
      o.region_id AS region_id,
      r.name AS region_name,
      o.location_id AS location_id,
      st.name AS station_name,
      o.is_buy_order AS is_buy_order,
      o.price AS price,
      o.volume_remain AS volume_remain,
      o.volume_total AS volume_total,
      o.issued AS issued
    FROM character_orders o
    LEFT JOIN sde_types t ON t.type_id = o.type_id
    LEFT JOIN sde_regions r ON r.region_id = o.region_id
    LEFT JOIN sde_stations st ON st.station_id = o.location_id
    WHERE o.character_id = ?
    ORDER BY o.issued DESC, o.order_id DESC
    LIMIT ? OFFSET ?
  `).all(characterId, limit, offset) as Array<{
    order_id: number;
    type_id: number;
    type_name: string | null;
    region_id: number | null;
    region_name: string | null;
    location_id: number | null;
    station_name: string | null;
    is_buy_order: number;
    price: number | null;
    volume_remain: number | null;
    volume_total: number | null;
    issued: string | null;
  }>;

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN is_buy_order = 0 THEN 1 ELSE 0 END), 0) AS sell_count,
      COALESCE(SUM(CASE WHEN is_buy_order = 0 THEN price * volume_remain ELSE 0 END), 0) AS sell_total,
      COALESCE(SUM(CASE WHEN is_buy_order = 1 THEN 1 ELSE 0 END), 0) AS buy_count,
      COALESCE(SUM(CASE WHEN is_buy_order = 1 THEN price * volume_remain ELSE 0 END), 0) AS buy_total,
      COALESCE(SUM(CASE WHEN is_buy_order = 1 THEN COALESCE(escrow, 0) ELSE 0 END), 0) AS escrow_total
    FROM character_orders
    WHERE character_id = ?
  `).get(characterId) as {
    sell_count: number;
    sell_total: number;
    buy_count: number;
    buy_total: number;
    escrow_total: number;
  };

  return {
    total,
    orders: orderRows.map((row) => ({
      orderId: row.order_id,
      typeId: row.type_id,
      typeName: row.type_name,
      regionId: row.region_id,
      regionName: row.region_name,
      locationId: row.location_id,
      locationKind: row.location_id === null
        ? null
        : row.location_id >= STRUCTURE_LOCATION_ID_THRESHOLD
          ? 'structure'
          : row.station_name === null
            ? 'other'
            : 'station',
      // Structures and unrecognized ids carry no server-side label: the kind
      // goes out and the client localizes the caption.
      locationName: row.location_id === null || row.location_id >= STRUCTURE_LOCATION_ID_THRESHOLD
        ? null
        : row.station_name,
      isBuyOrder: row.is_buy_order === 1,
      price: row.price,
      volumeRemain: row.volume_remain,
      volumeTotal: row.volume_total,
      issued: row.issued,
    })),
    totals: {
      sellCount: totals.sell_count,
      sellTotal: totals.sell_total,
      buyCount: totals.buy_count,
      buyTotal: totals.buy_total,
      escrowTotal: totals.escrow_total,
    },
  };
}

export function walletSummary(db: Db, characterId: number): WalletSummary {
  const wallet = db.prepare(
    'SELECT balance FROM character_wallet WHERE character_id = ?',
  ).get(characterId) as { balance: number } | undefined;

  // One row per day over the last 30 days: delta is the day's sum, balance is
  // the balance of the day's last entry.
  const days = db.prepare(`
    SELECT day, delta, balance FROM (
      SELECT
        substr(date, 1, 10) AS day,
        SUM(amount) OVER (PARTITION BY substr(date, 1, 10)) AS delta,
        balance AS balance,
        ROW_NUMBER() OVER (
          PARTITION BY substr(date, 1, 10)
          ORDER BY date DESC, journal_id DESC
        ) AS rn
      FROM character_wallet_journal
      WHERE character_id = ?
        AND date IS NOT NULL
        AND substr(date, 1, 10) >= date('now', '-30 days')
    )
    WHERE rn = 1
    ORDER BY day ASC
  `).all(characterId) as Array<{ day: string; delta: number; balance: number | null }>;

  return {
    balance: wallet?.balance ?? null,
    journal: days.map((row) => ({ date: row.day, delta: row.delta, balance: row.balance })),
  };
}

function parseTypeIdArray(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    );
  } catch {
    return [];
  }
}

function parseHomeLocationId(raw: string | null | undefined): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const locationId = (parsed as Record<string, unknown>).location_id;
    return typeof locationId === 'number' && Number.isFinite(locationId) && locationId > 0
      ? locationId
      : null;
  } catch {
    return null;
  }
}

function locationName(db: Db, locationId: number): string | null {
  return resolveLocationInfo(db, locationId).name;
}

export function clonesSummary(db: Db, characterId: number): ClonesSummary {
  const profile = db.prepare(`
    SELECT home_location_json, implants_json FROM character_profile WHERE character_id = ?
  `).get(characterId) as { home_location_json: string | null; implants_json: string } | undefined;

  const cloneRows = db.prepare(`
    SELECT jump_clone_id, name, location_id, location_type, implants_json
    FROM character_clones
    WHERE character_id = ?
    ORDER BY jump_clone_id ASC
  `).all(characterId) as Array<{
    jump_clone_id: number;
    name: string | null;
    location_id: number | null;
    location_type: string | null;
    implants_json: string;
  }>;

  const currentImplantIds = parseTypeIdArray(profile?.implants_json);
  const cloneImplantIds = cloneRows.map((row) => parseTypeIdArray(row.implants_json));
  const allImplantIds = new Set<number>(currentImplantIds);
  for (const ids of cloneImplantIds) {
    for (const id of ids) allImplantIds.add(id);
  }
  const names = loadTypeNames(db, [...allImplantIds]);
  const toImplants = (ids: readonly number[]): Implant[] =>
    ids.map((id) => ({ typeId: id, typeName: names.get(id) ?? null }));

  const homeLocationId = parseHomeLocationId(profile?.home_location_json);
  return {
    home: homeLocationId === null
      ? null
      : { locationId: homeLocationId, locationName: locationName(db, homeLocationId) },
    jumpClones: cloneRows.map((row, index) => ({
      jumpCloneId: row.jump_clone_id,
      name: row.name,
      locationId: row.location_id,
      locationName: row.location_id === null ? null : locationName(db, row.location_id),
      implants: toImplants(cloneImplantIds[index] ?? []),
    })),
    currentImplants: toImplants(currentImplantIds),
  };
}

export function skillsSummary(db: Db, characterId: number): SkillsSummary {
  const profile = db.prepare(`
    SELECT total_skill_points, unallocated_skill_points FROM character_profile WHERE character_id = ?
  `).get(characterId) as {
    total_skill_points: number | null;
    unallocated_skill_points: number | null;
  } | undefined;

  const queue = db.prepare(`
    SELECT
      q.queue_position AS queue_position,
      q.skill_id AS skill_id,
      t.name AS skill_name,
      q.finished_level AS finished_level,
      q.start_date AS start_date,
      q.finish_date AS finish_date
    FROM character_skillqueue q
    LEFT JOIN sde_types t ON t.type_id = q.skill_id
    WHERE q.character_id = ?
    ORDER BY q.queue_position ASC
  `).all(characterId) as Array<{
    queue_position: number;
    skill_id: number | null;
    skill_name: string | null;
    finished_level: number | null;
    start_date: string | null;
    finish_date: string | null;
  }>;

  return {
    totalSp: profile?.total_skill_points ?? null,
    unallocatedSp: profile?.unallocated_skill_points ?? null,
    queue: queue.map((row) => ({
      queuePosition: row.queue_position,
      skillId: row.skill_id,
      skillName: row.skill_name,
      finishedLevel: row.finished_level,
      startDate: row.start_date,
      finishDate: row.finish_date,
    })),
  };
}

/**
 * Dataset errors can carry raw ESI response bodies ('ESI 500: <body>') — an
 * internal detail the browser must not see. Collapse to the bare status; the
 * full text stays in character_sync_state for server-side inspection.
 */
export function sanitizeDatasetError(error: string | null): string | null {
  if (!error) return error;
  const match = /^ESI (\d{3}):/.exec(error);
  return match ? `ESI недоступен (${match[1]})` : error;
}

export function accessSummary(db: Db, characterId: number, scopes: string[]): AccessSummary {
  const granted = new Set(scopes);
  const requirements = characterDatasetRequirements();
  const requiredScopesByDataset = new Map(requirements.map((entry) => [entry.id, entry.requiredScopes]));
  const statuses = getCharacterDatasetStatuses(db, characterId, requirements.map((entry) => entry.id));

  return {
    scopes,
    groups: EVE_ACCESS_GROUP_IDS.map((id) => {
      const required = EVE_ACCESS_GROUPS[id];
      return {
        id,
        label: ACCESS_GROUP_LABELS[id],
        granted: required.filter((scope) => granted.has(scope)),
        missing: required.filter((scope) => !granted.has(scope)),
      };
    }),
    datasets: statuses.map((status) => ({
      dataset: status.dataset,
      status: status.status,
      syncedAt: status.synced_at,
      expiresAt: status.expires_at,
      error: sanitizeDatasetError(status.error),
      requiredScopes: requiredScopesByDataset.get(status.dataset) ?? [],
    })),
  };
}
