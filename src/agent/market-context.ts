import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';

export const DEFAULT_MARKET_REGION = {
  id: config.market.defaultRegionId,
  name: config.market.defaultRegionName,
} as const;

export function resolveMarketRegion(
  db: Db,
  userProfile: string | null,
): { id: number; name: string } {
  const systemId = Number(/- System:\s+.+\((\d+)\)/.exec(userProfile ?? '')?.[1] ?? '');
  if (!Number.isFinite(systemId)) return DEFAULT_MARKET_REGION;

  const row = db.prepare(`
    SELECT r.region_id AS region_id, r.name AS region_name
    FROM sde_systems s
    JOIN sde_constellations c ON c.constellation_id = s.constellation_id
    JOIN sde_regions r ON r.region_id = c.region_id
    WHERE s.system_id = ?
  `).get(systemId) as { region_id: number; region_name: string } | undefined;

  if (!row?.region_id || !row.region_name) return DEFAULT_MARKET_REGION;
  return { id: row.region_id, name: row.region_name };
}

export function resolveNamedMarketRegion(
  db: Db,
  name: string | null,
): { id: number; name: string } | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return null;

  const region = db.prepare(
    'SELECT region_id, name FROM sde_regions WHERE name = ? COLLATE NOCASE LIMIT 1'
  ).get(trimmed) as { region_id: number; name: string } | undefined;
  if (region?.region_id && region.name) {
    return { id: region.region_id, name: region.name };
  }

  const system = db.prepare(`
    SELECT r.region_id AS region_id, r.name AS region_name
    FROM sde_systems s
    JOIN sde_constellations c ON c.constellation_id = s.constellation_id
    JOIN sde_regions r ON r.region_id = c.region_id
    WHERE s.name = ? COLLATE NOCASE
    LIMIT 1
  `).get(trimmed) as { region_id: number; region_name: string } | undefined;
  if (system?.region_id && system.region_name) {
    return { id: system.region_id, name: system.region_name };
  }
  return null;
}
