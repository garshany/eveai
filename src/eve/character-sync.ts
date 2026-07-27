import type { Db } from '../db/sqlite.js';
import { deleteCharacterData } from '../db/character-datastore.js';
import { config } from '../config.js';
import { callEsiOperation, type EsiExecutionGuard } from './esi-client.js';
import { getEveCapabilities } from './capabilities.js';
import { getLinkedCharacter } from './sso.js';
import type { UserContext } from '../auth/user-resolver.js';

/**
 * Character datastore sync: mirrors the private ESI profile of the ACTIVE
 * linked character into the local character_* tables so the character_sql
 * agent tool can answer profile questions with SQL instead of dumping raw ESI
 * payloads into the model context.
 *
 * Strategy: lazy on-demand refresh with per-dataset TTL. character_sql asks
 * for the datasets backing the tables its query references; a dataset is only
 * re-fetched once its ESI Expires-based freshness (fallback: configured TTL)
 * has elapsed. Failures degrade per dataset: stale rows are served and the
 * dataset is retried only after a bounded backoff, so one broken endpoint or
 * a missing scope never blocks the rest of the profile.
 */

export type CharacterDatasetId =
  | 'assets'
  | 'wallet'
  | 'wallet_journal'
  | 'orders'
  | 'contracts'
  | 'skills'
  | 'skillqueue'
  | 'clones'
  | 'standings'
  | 'presence';

export type CharacterDatasetStatus = {
  dataset: CharacterDatasetId;
  status: 'pending' | 'ok' | 'error' | 'no_scope';
  rows_synced: number;
  synced_at: string | null;
  expires_at: string | null;
  error: string | null;
};

type CharacterDataset = {
  id: CharacterDatasetId;
  /** Scopes the token must carry; 'all' = every scope, 'any' = at least one. */
  requiredScopes: string[];
  scopeMode: 'all' | 'any';
  sync: (
    db: Db,
    characterId: number,
    ctx: UserContext,
    guard: EsiExecutionGuard,
  ) => Promise<SyncWriteResult>;
};

type SyncWriteResult = {
  rows: number;
  /** Earliest ESI Expires among the dataset's calls: the safe freshness bound. */
  expiresAt: string;
};

function earliestExpiry(values: string[]): string {
  return values.reduce((min, value) => (value < min ? value : min));
}

/** Maps a character_* table to the datasets that fill it. */
const TABLE_TO_DATASETS: Record<string, CharacterDatasetId[]> = {
  character_assets: ['assets'],
  character_wallet: ['wallet'],
  character_wallet_journal: ['wallet_journal'],
  character_orders: ['orders'],
  character_contracts: ['contracts'],
  character_skills: ['skills'],
  character_skillqueue: ['skillqueue'],
  character_clones: ['clones'],
  character_standings: ['standings'],
  character_presence: ['presence'],
  // Rollup row: totals come from the skills endpoint, implants/home location
  // from the clones dataset.
  character_profile: ['skills', 'clones'],
  character_sync_state: [],
};

export function datasetsForTables(tables: readonly string[]): CharacterDatasetId[] {
  const datasets = new Set<CharacterDatasetId>();
  for (const table of tables) {
    for (const dataset of TABLE_TO_DATASETS[table] ?? []) {
      datasets.add(dataset);
    }
  }
  return [...datasets];
}

// --- payload coercion helpers (ESI is an external boundary: validate loosely,
// skip unkeyable rows, never throw on a missing optional field) ---

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function bool01(value: unknown): number {
  return value === true ? 1 : 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sqlNowPlus(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/** Normalizes an ESI Expires header (HTTP date or sqlite datetime) to sqlite UTC. */
function resolveExpiresAt(rawExpires: string | undefined): string {
  if (rawExpires) {
    const parsed = Date.parse(rawExpires.includes('T') ? rawExpires : rawExpires.replace(' ', 'T') + 'Z');
    if (!Number.isNaN(parsed) && parsed > Date.now()) {
      return new Date(parsed).toISOString().replace('T', ' ').slice(0, 19);
    }
  }
  return sqlNowPlus(config.characterSync.fallbackTtlSeconds);
}

async function callCharacterOp<T>(
  operation: string,
  ctx: UserContext,
  guard: EsiExecutionGuard,
  db: Db,
): Promise<{ ok: true; data: T; expiresAt: string } | { ok: false; error: string }> {
  const result = await callEsiOperation<T>(db, operation, {}, ctx, {
    ...guard,
    maxPages: config.characterSync.maxPages,
  });
  if (!result.ok) {
    return { ok: false, error: `ESI ${result.status}: ${result.error}` };
  }
  return { ok: true, data: result.data, expiresAt: resolveExpiresAt(result.headers?.expires) };
}

// --- dataset sync implementations ---

async function syncAssets(db: Db, characterId: number, ctx: UserContext, guard: EsiExecutionGuard): Promise<SyncWriteResult> {
  const result = await callCharacterOp<unknown[]>('get_characters_character_id_assets', ctx, guard, db);
  if (!result.ok) throw new Error(result.error);
  const rows = asArray(result.data);
  const insert = db.prepare(`
    INSERT INTO character_assets (
      character_id, item_id, type_id, location_id, location_type, location_flag,
      quantity, is_singleton, is_blueprint_copy, data_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  db.transaction(() => {
    db.prepare('DELETE FROM character_assets WHERE character_id = ?').run(characterId);
    for (const raw of rows) {
      const item = asRecord(raw);
      const itemId = intOrNull(item?.item_id);
      const typeId = intOrNull(item?.type_id);
      const locationId = numOrNull(item?.location_id);
      if (!item || itemId === null || typeId === null || locationId === null) continue;
      insert.run(
        characterId, itemId, typeId, locationId,
        strOrNull(item.location_type), strOrNull(item.location_flag),
        intOrNull(item.quantity), bool01(item.is_singleton),
        item.is_blueprint_copy === undefined ? null : bool01(item.is_blueprint_copy),
        JSON.stringify(item),
      );
    }
  })();
  return { rows: rows.length, expiresAt: result.expiresAt };
}

async function syncWallet(db: Db, characterId: number, ctx: UserContext, guard: EsiExecutionGuard): Promise<SyncWriteResult> {
  const result = await callCharacterOp<number>('get_characters_character_id_wallet', ctx, guard, db);
  if (!result.ok) throw new Error(result.error);
  const balance = typeof result.data === 'number' && Number.isFinite(result.data) ? result.data : 0;
  db.prepare(`
    INSERT INTO character_wallet (character_id, balance, synced_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(character_id) DO UPDATE SET balance = excluded.balance, synced_at = excluded.synced_at
  `).run(characterId, balance);
  return { rows: 1, expiresAt: result.expiresAt };
}

async function syncWalletJournal(db: Db, characterId: number, ctx: UserContext, guard: EsiExecutionGuard): Promise<SyncWriteResult> {
  const result = await callCharacterOp<unknown[]>('get_characters_character_id_wallet_journal', ctx, guard, db);
  if (!result.ok) throw new Error(result.error);
  const rows = asArray(result.data);
  // Journal entries are immutable and id-keyed: upsert, never delete, so
  // history older than the page cap survives every refresh.
  const upsert = db.prepare(`
    INSERT INTO character_wallet_journal (
      character_id, journal_id, date, ref_type, amount, balance,
      first_party_id, second_party_id, description, context_id, context_id_type,
      data_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(character_id, journal_id) DO UPDATE SET
      date = excluded.date,
      ref_type = excluded.ref_type,
      amount = excluded.amount,
      balance = excluded.balance,
      first_party_id = excluded.first_party_id,
      second_party_id = excluded.second_party_id,
      description = excluded.description,
      context_id = excluded.context_id,
      context_id_type = excluded.context_id_type,
      data_json = excluded.data_json,
      synced_at = excluded.synced_at
  `);
  db.transaction(() => {
    for (const raw of rows) {
      const entry = asRecord(raw);
      const journalId = numOrNull(entry?.id);
      if (!entry || journalId === null) continue;
      upsert.run(
        characterId, journalId,
        strOrNull(entry.date), strOrNull(entry.ref_type),
        numOrNull(entry.amount), numOrNull(entry.balance),
        numOrNull(entry.first_party_id), numOrNull(entry.second_party_id),
        strOrNull(entry.description), numOrNull(entry.context_id),
        strOrNull(entry.context_id_type), JSON.stringify(entry),
      );
    }
  })();
  return { rows: rows.length, expiresAt: result.expiresAt };
}

async function syncOrders(db: Db, characterId: number, ctx: UserContext, guard: EsiExecutionGuard): Promise<SyncWriteResult> {
  const result = await callCharacterOp<unknown[]>('get_characters_character_id_orders', ctx, guard, db);
  if (!result.ok) throw new Error(result.error);
  const rows = asArray(result.data);
  const insert = db.prepare(`
    INSERT INTO character_orders (
      character_id, order_id, type_id, region_id, location_id, price,
      volume_total, volume_remain, min_volume, is_buy_order, range, duration,
      issued, escrow, data_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  db.transaction(() => {
    db.prepare('DELETE FROM character_orders WHERE character_id = ?').run(characterId);
    for (const raw of rows) {
      const order = asRecord(raw);
      const orderId = numOrNull(order?.order_id);
      const typeId = intOrNull(order?.type_id);
      if (!order || orderId === null || typeId === null) continue;
      insert.run(
        characterId, orderId, typeId,
        intOrNull(order.region_id), numOrNull(order.location_id), numOrNull(order.price),
        intOrNull(order.volume_total), intOrNull(order.volume_remain), intOrNull(order.min_volume),
        bool01(order.is_buy_order), strOrNull(order.range), intOrNull(order.duration),
        strOrNull(order.issued), numOrNull(order.escrow), JSON.stringify(order),
      );
    }
  })();
  return { rows: rows.length, expiresAt: result.expiresAt };
}

async function syncContracts(db: Db, characterId: number, ctx: UserContext, guard: EsiExecutionGuard): Promise<SyncWriteResult> {
  const result = await callCharacterOp<unknown[]>('get_characters_character_id_contracts', ctx, guard, db);
  if (!result.ok) throw new Error(result.error);
  const rows = asArray(result.data);
  // Contract ids are stable and statuses mutate in place: upsert so contracts
  // that aged out of the ESI window remain queryable.
  const upsert = db.prepare(`
    INSERT INTO character_contracts (
      character_id, contract_id, type, status, availability, price, reward,
      collateral, volume, title, date_issued, date_expired, date_accepted,
      date_completed, issuer_id, assignee_id, acceptor_id, start_location_id,
      end_location_id, for_corporation, data_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(character_id, contract_id) DO UPDATE SET
      status = excluded.status,
      date_accepted = excluded.date_accepted,
      date_completed = excluded.date_completed,
      acceptor_id = excluded.acceptor_id,
      data_json = excluded.data_json,
      synced_at = excluded.synced_at
  `);
  db.transaction(() => {
    for (const raw of rows) {
      const contract = asRecord(raw);
      const contractId = numOrNull(contract?.contract_id);
      if (!contract || contractId === null) continue;
      upsert.run(
        characterId, contractId,
        strOrNull(contract.type), strOrNull(contract.status), strOrNull(contract.availability),
        numOrNull(contract.price), numOrNull(contract.reward), numOrNull(contract.collateral),
        numOrNull(contract.volume), strOrNull(contract.title),
        strOrNull(contract.date_issued), strOrNull(contract.date_expired),
        strOrNull(contract.date_accepted), strOrNull(contract.date_completed),
        numOrNull(contract.issuer_id), numOrNull(contract.assignee_id), numOrNull(contract.acceptor_id),
        numOrNull(contract.start_location_id), numOrNull(contract.end_location_id),
        bool01(contract.for_corporation), JSON.stringify(contract),
      );
    }
  })();
  return { rows: rows.length, expiresAt: result.expiresAt };
}

function upsertProfileTotals(
  db: Db,
  characterId: number,
  patch: { totalSp?: number | null; unallocatedSp?: number | null; homeLocationJson?: string | null; implantsJson?: string | null; characterName?: string | null },
): void {
  db.prepare(`
    INSERT INTO character_profile (
      character_id, character_name, total_skill_points, unallocated_skill_points,
      implants_json, home_location_json, synced_at
    ) VALUES (?, ?, ?, ?, COALESCE(?, '[]'), ?, datetime('now'))
    ON CONFLICT(character_id) DO UPDATE SET
      character_name = COALESCE(excluded.character_name, character_profile.character_name),
      total_skill_points = COALESCE(excluded.total_skill_points, character_profile.total_skill_points),
      unallocated_skill_points = COALESCE(excluded.unallocated_skill_points, character_profile.unallocated_skill_points),
      implants_json = COALESCE(excluded.implants_json, character_profile.implants_json),
      home_location_json = COALESCE(excluded.home_location_json, character_profile.home_location_json),
      synced_at = datetime('now')
  `).run(
    characterId,
    patch.characterName ?? null,
    patch.totalSp ?? null,
    patch.unallocatedSp ?? null,
    patch.implantsJson ?? null,
    patch.homeLocationJson ?? null,
  );
}

async function syncSkills(db: Db, characterId: number, ctx: UserContext, guard: EsiExecutionGuard): Promise<SyncWriteResult> {
  const result = await callCharacterOp<unknown>('get_characters_character_id_skills', ctx, guard, db);
  if (!result.ok) throw new Error(result.error);
  const payload = asRecord(result.data) ?? {};
  const skills = asArray(payload.skills);
  const insert = db.prepare(`
    INSERT INTO character_skills (
      character_id, skill_id, trained_skill_level, active_skill_level,
      skillpoints_in_skill, data_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  db.transaction(() => {
    db.prepare('DELETE FROM character_skills WHERE character_id = ?').run(characterId);
    for (const raw of skills) {
      const skill = asRecord(raw);
      const skillId = intOrNull(skill?.skill_id);
      if (!skill || skillId === null) continue;
      insert.run(
        characterId, skillId,
        intOrNull(skill.trained_skill_level), intOrNull(skill.active_skill_level),
        numOrNull(skill.skillpoints_in_skill), JSON.stringify(skill),
      );
    }
    upsertProfileTotals(db, characterId, {
      totalSp: numOrNull(payload.total_sp),
      unallocatedSp: numOrNull(payload.unallocated_sp),
    });
  })();
  return { rows: skills.length, expiresAt: result.expiresAt };
}

async function syncSkillqueue(db: Db, characterId: number, ctx: UserContext, guard: EsiExecutionGuard): Promise<SyncWriteResult> {
  const result = await callCharacterOp<unknown[]>('get_characters_character_id_skillqueue', ctx, guard, db);
  if (!result.ok) throw new Error(result.error);
  const rows = asArray(result.data);
  const insert = db.prepare(`
    INSERT INTO character_skillqueue (
      character_id, queue_position, skill_id, finished_level, start_date,
      finish_date, training_start_sp, level_start_sp, level_end_sp, data_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  db.transaction(() => {
    db.prepare('DELETE FROM character_skillqueue WHERE character_id = ?').run(characterId);
    for (const raw of rows) {
      const entry = asRecord(raw);
      const position = intOrNull(entry?.queue_position);
      if (!entry || position === null) continue;
      insert.run(
        characterId, position, intOrNull(entry.skill_id), intOrNull(entry.finished_level),
        strOrNull(entry.start_date), strOrNull(entry.finish_date),
        numOrNull(entry.training_start_sp), numOrNull(entry.level_start_sp),
        numOrNull(entry.level_end_sp), JSON.stringify(entry),
      );
    }
  })();
  return { rows: rows.length, expiresAt: result.expiresAt };
}

async function syncClones(db: Db, characterId: number, ctx: UserContext, guard: EsiExecutionGuard): Promise<SyncWriteResult> {
  const result = await callCharacterOp<unknown>('get_characters_character_id_clones', ctx, guard, db);
  if (!result.ok) throw new Error(result.error);
  const payload = asRecord(result.data) ?? {};
  const clones = asArray(payload.jump_clones);
  const insert = db.prepare(`
    INSERT INTO character_clones (
      character_id, jump_clone_id, location_id, location_type, name,
      implants_json, data_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  let synced = clones.length;
  db.transaction(() => {
    db.prepare('DELETE FROM character_clones WHERE character_id = ?').run(characterId);
    for (const raw of clones) {
      const clone = asRecord(raw);
      const cloneId = numOrNull(clone?.jump_clone_id);
      if (!clone || cloneId === null) continue;
      insert.run(
        characterId, cloneId,
        numOrNull(clone.location_id), strOrNull(clone.location_type), strOrNull(clone.name),
        JSON.stringify(asArray(clone.implants)), JSON.stringify(clone),
      );
    }
    if (payload.home_location) {
      upsertProfileTotals(db, characterId, { homeLocationJson: JSON.stringify(payload.home_location) });
    }
  })();

  // Current implants ride a separate scope/endpoint; their absence degrades
  // only the implants column, never the clones dataset.
  const expiries = [result.expiresAt];
  const linked = getLinkedCharacter(db, ctx);
  if (linked?.scopes.includes('esi-clones.read_implants.v1')) {
    const implants = await callCharacterOp<unknown[]>('get_characters_character_id_implants', ctx, guard, db);
    if (implants.ok) {
      upsertProfileTotals(db, characterId, { implantsJson: JSON.stringify(asArray(implants.data)) });
      expiries.push(implants.expiresAt);
      synced += 1;
    }
  }
  return { rows: synced, expiresAt: earliestExpiry(expiries) };
}

async function syncStandings(db: Db, characterId: number, ctx: UserContext, guard: EsiExecutionGuard): Promise<SyncWriteResult> {
  const result = await callCharacterOp<unknown[]>('get_characters_character_id_standings', ctx, guard, db);
  if (!result.ok) throw new Error(result.error);
  const rows = asArray(result.data);
  const insert = db.prepare(`
    INSERT INTO character_standings (
      character_id, from_id, from_type, standing, data_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  db.transaction(() => {
    db.prepare('DELETE FROM character_standings WHERE character_id = ?').run(characterId);
    for (const raw of rows) {
      const standing = asRecord(raw);
      const fromId = numOrNull(standing?.from_id);
      const fromType = strOrNull(standing?.from_type);
      if (!standing || fromId === null || fromType === null) continue;
      insert.run(characterId, fromId, fromType, numOrNull(standing.standing), JSON.stringify(standing));
    }
  })();
  return { rows: rows.length, expiresAt: result.expiresAt };
}

async function syncPresence(db: Db, characterId: number, ctx: UserContext, guard: EsiExecutionGuard): Promise<SyncWriteResult> {
  const linked = getLinkedCharacter(db, ctx);
  const scopes = new Set(linked?.scopes ?? []);
  const current = db.prepare(
    'SELECT * FROM character_presence WHERE character_id = ?',
  ).get(characterId) as Record<string, unknown> | undefined;

  let solarSystemId = numOrNull(current?.solar_system_id);
  let stationId = numOrNull(current?.station_id);
  let structureId = numOrNull(current?.structure_id);
  let shipTypeId = intOrNull(current?.ship_type_id);
  let shipName = strOrNull(current?.ship_name);
  let shipItemId = numOrNull(current?.ship_item_id);
  let online = intOrNull(current?.online);
  let lastLogin = strOrNull(current?.last_login);
  let lastLogout = strOrNull(current?.last_logout);
  let fetched = 0;
  const expiries: string[] = [];

  if (scopes.has('esi-location.read_location.v1')) {
    const location = await callCharacterOp<unknown>('get_characters_character_id_location', ctx, guard, db);
    if (location.ok) {
      const payload = asRecord(location.data) ?? {};
      solarSystemId = numOrNull(payload.solar_system_id);
      stationId = numOrNull(payload.station_id);
      structureId = numOrNull(payload.structure_id);
      expiries.push(location.expiresAt);
      fetched += 1;
    }
  }
  if (scopes.has('esi-location.read_ship_type.v1')) {
    const ship = await callCharacterOp<unknown>('get_characters_character_id_ship', ctx, guard, db);
    if (ship.ok) {
      const payload = asRecord(ship.data) ?? {};
      shipTypeId = intOrNull(payload.ship_type_id);
      shipName = strOrNull(payload.ship_name);
      shipItemId = numOrNull(payload.ship_item_id);
      expiries.push(ship.expiresAt);
      fetched += 1;
    }
  }
  if (scopes.has('esi-location.read_online.v1')) {
    const onlineResult = await callCharacterOp<unknown>('get_characters_character_id_online', ctx, guard, db);
    if (onlineResult.ok) {
      const payload = asRecord(onlineResult.data) ?? {};
      online = bool01(payload.online);
      lastLogin = strOrNull(payload.last_login);
      lastLogout = strOrNull(payload.last_logout);
      expiries.push(onlineResult.expiresAt);
      fetched += 1;
    }
  }

  if (fetched === 0) {
    throw new Error('No presence endpoint succeeded (location/ship/online).');
  }

  db.prepare(`
    INSERT INTO character_presence (
      character_id, solar_system_id, station_id, structure_id, ship_type_id,
      ship_name, ship_item_id, online, last_login, last_logout, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(character_id) DO UPDATE SET
      solar_system_id = excluded.solar_system_id,
      station_id = excluded.station_id,
      structure_id = excluded.structure_id,
      ship_type_id = excluded.ship_type_id,
      ship_name = excluded.ship_name,
      ship_item_id = excluded.ship_item_id,
      online = excluded.online,
      last_login = excluded.last_login,
      last_logout = excluded.last_logout,
      synced_at = excluded.synced_at
  `).run(
    characterId, solarSystemId, stationId, structureId, shipTypeId,
    shipName, shipItemId, online, lastLogin, lastLogout,
  );
  return { rows: fetched, expiresAt: earliestExpiry(expiries) };
}

const CHARACTER_DATASETS: readonly CharacterDataset[] = [
  {
    id: 'assets',
    requiredScopes: ['esi-assets.read_assets.v1'],
    scopeMode: 'all',
    sync: syncAssets,
  },
  {
    id: 'wallet',
    requiredScopes: ['esi-wallet.read_character_wallet.v1'],
    scopeMode: 'all',
    sync: syncWallet,
  },
  {
    id: 'wallet_journal',
    requiredScopes: ['esi-wallet.read_character_wallet.v1'],
    scopeMode: 'all',
    sync: syncWalletJournal,
  },
  {
    id: 'orders',
    requiredScopes: ['esi-markets.read_character_orders.v1'],
    scopeMode: 'all',
    sync: syncOrders,
  },
  {
    id: 'contracts',
    requiredScopes: ['esi-contracts.read_character_contracts.v1'],
    scopeMode: 'all',
    sync: syncContracts,
  },
  {
    id: 'skills',
    requiredScopes: ['esi-skills.read_skills.v1'],
    scopeMode: 'all',
    sync: syncSkills,
  },
  {
    id: 'skillqueue',
    requiredScopes: ['esi-skills.read_skillqueue.v1'],
    scopeMode: 'all',
    sync: syncSkillqueue,
  },
  {
    id: 'clones',
    requiredScopes: ['esi-clones.read_clones.v1'],
    scopeMode: 'all',
    sync: syncClones,
  },
  {
    id: 'standings',
    requiredScopes: ['esi-characters.read_standings.v1'],
    scopeMode: 'all',
    sync: syncStandings,
  },
  {
    id: 'presence',
    requiredScopes: [
      'esi-location.read_location.v1',
      'esi-location.read_ship_type.v1',
      'esi-location.read_online.v1',
    ],
    scopeMode: 'any',
    sync: syncPresence,
  },
];

const DATASETS_BY_ID = new Map(CHARACTER_DATASETS.map((dataset) => [dataset.id, dataset]));

// In-flight dedupe: parallel character_sql calls in one turn share a single
// refresh per (character, dataset) instead of stampeding ESI.
const syncInFlight = new Map<string, Promise<void>>();

function readDatasetState(
  db: Db,
  characterId: number,
  dataset: CharacterDatasetId,
): CharacterDatasetStatus {
  const row = db.prepare(`
    SELECT status, rows_synced, synced_at, expires_at, error
    FROM character_sync_state
    WHERE character_id = ? AND dataset = ?
  `).get(characterId, dataset) as Omit<CharacterDatasetStatus, 'dataset'> | undefined;
  return {
    dataset,
    status: row?.status ?? 'pending',
    rows_synced: row?.rows_synced ?? 0,
    synced_at: row?.synced_at ?? null,
    expires_at: row?.expires_at ?? null,
    error: row?.error ?? null,
  };
}

function writeDatasetState(
  db: Db,
  characterId: number,
  dataset: CharacterDatasetId,
  patch: { status: CharacterDatasetStatus['status']; rowsSynced?: number; expiresAt?: string | null; error?: string | null },
): void {
  // synced_at/rows_synced describe the last SUCCESSFUL sync; error and
  // no_scope states must not clobber them.
  const succeeded = patch.status === 'ok';
  db.prepare(`
    INSERT INTO character_sync_state (character_id, dataset, status, rows_synced, synced_at, expires_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(character_id, dataset) DO UPDATE SET
      status = excluded.status,
      rows_synced = CASE WHEN ? THEN excluded.rows_synced ELSE character_sync_state.rows_synced END,
      synced_at = CASE WHEN ? THEN excluded.synced_at ELSE character_sync_state.synced_at END,
      expires_at = excluded.expires_at,
      error = excluded.error
  `).run(
    characterId, dataset, patch.status,
    patch.rowsSynced ?? 0,
    succeeded ? sqlNowPlus(0) : null,
    patch.expiresAt ?? null, patch.error ?? null,
    succeeded ? 1 : 0, succeeded ? 1 : 0,
  );
}

function isFutureSqlUtc(value: string | null): boolean {
  if (!value) return false;
  return Date.parse(value.replace(' ', 'T') + 'Z') > Date.now();
}

function hasRequiredScopes(dataset: CharacterDataset, scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return dataset.scopeMode === 'any'
    ? dataset.requiredScopes.some((scope) => granted.has(scope))
    : dataset.requiredScopes.every((scope) => granted.has(scope));
}

export function getCharacterDatasetStatuses(
  db: Db,
  characterId: number,
  datasets: readonly CharacterDatasetId[],
): CharacterDatasetStatus[] {
  return datasets.map((dataset) => readDatasetState(db, characterId, dataset));
}

/** Public view of the dataset registry for the web access tab. */
export function characterDatasetRequirements(): Array<{
  id: CharacterDatasetId;
  requiredScopes: string[];
  scopeMode: 'all' | 'any';
}> {
  return CHARACTER_DATASETS.map((dataset) => ({
    id: dataset.id,
    requiredScopes: [...dataset.requiredScopes],
    scopeMode: dataset.scopeMode,
  }));
}

/**
 * Refreshes the requested datasets for the caller's ACTIVE linked character
 * when their freshness window elapsed. Never throws: every dataset ends in
 * 'ok', 'no_scope' or 'error' and stale rows stay queryable. Returns the
 * per-dataset status after the run.
 */
export async function ensureCharacterDatasetsFresh(
  db: Db,
  ctx: UserContext,
  datasets: readonly CharacterDatasetId[],
  guard: EsiExecutionGuard = {},
): Promise<CharacterDatasetStatus[]> {
  return syncCharacterDatasets(db, ctx, datasets, guard, (dataset, state, scopes) => {
    // A recent failure backs off instead of re-hitting ESI on every query.
    if (state.status === 'error' && isFutureSqlUtc(state.expires_at)) return false;
    if (state.status === 'no_scope' && !hasRequiredScopes(dataset, scopes)) {
      return false;
    }
    return !isFutureSqlUtc(state.expires_at);
  });
}

/**
 * Force-refresh variant of ensureCharacterDatasetsFresh behind the manual web
 * "sync now" button: ignores the TTL (fresh rows are refetched too) and the
 * error backoff. Scope checks still apply — a dataset without its scopes is
 * recorded as no_scope without touching ESI. Never throws.
 */
export async function refreshCharacterDatasets(
  db: Db,
  ctx: UserContext,
  datasets: readonly CharacterDatasetId[],
  guard: EsiExecutionGuard = {},
): Promise<CharacterDatasetStatus[]> {
  return syncCharacterDatasets(db, ctx, datasets, guard, () => true);
}

async function syncCharacterDatasets(
  db: Db,
  ctx: UserContext,
  datasets: readonly CharacterDatasetId[],
  guard: EsiExecutionGuard,
  shouldSync: (
    dataset: CharacterDataset,
    state: CharacterDatasetStatus,
    scopes: readonly string[],
  ) => boolean,
): Promise<CharacterDatasetStatus[]> {
  const linked = getLinkedCharacter(db, ctx);
  if (!linked) return [];
  const characterId = linked.characterId;

  const pending = datasets.filter((datasetId) => {
    const dataset = DATASETS_BY_ID.get(datasetId);
    if (!dataset) return false;
    return shouldSync(dataset, readDatasetState(db, characterId, datasetId), linked.scopes);
  });

  if (pending.length > 0) {
    // Private ESI calls require a fresh capability snapshot (else 428). One
    // call covers every dataset refresh below.
    await getEveCapabilities(db, 'character datastore sync', ctx);
    for (const datasetId of pending) {
      const key = `${characterId}:${datasetId}`;
      const existing = syncInFlight.get(key);
      if (existing) {
        await existing.catch(() => undefined);
        continue;
      }
      const run = refreshDataset(db, characterId, datasetId, linked.scopes, ctx, guard)
        .finally(() => syncInFlight.delete(key));
      syncInFlight.set(key, run);
      await run.catch(() => undefined);
    }
  }

  return getCharacterDatasetStatuses(db, characterId, datasets);
}

async function refreshDataset(
  db: Db,
  characterId: number,
  datasetId: CharacterDatasetId,
  scopes: readonly string[],
  ctx: UserContext,
  guard: EsiExecutionGuard,
): Promise<void> {
  const dataset = DATASETS_BY_ID.get(datasetId);
  if (!dataset) return;

  if (!hasRequiredScopes(dataset, scopes)) {
    writeDatasetState(db, characterId, datasetId, {
      status: 'no_scope',
      error: `Missing scope: ${dataset.requiredScopes.join(dataset.scopeMode === 'any' ? ' or ' : ', ')}`,
    });
    return;
  }

  try {
    const written = await dataset.sync(db, characterId, ctx, guard);
    writeDatasetState(db, characterId, datasetId, {
      status: 'ok',
      rowsSynced: written.rows,
      expiresAt: written.expiresAt,
      error: null,
    });
  } catch (error) {
    writeDatasetState(db, characterId, datasetId, {
      status: 'error',
      expiresAt: sqlNowPlus(config.characterSync.errorRetrySeconds),
      error: (error as Error).message.slice(0, 300),
    });
  }
}

// Lifecycle deletion (unlink/purge/ownership change) lives in
// src/db/character-datastore.ts and is re-exported here for eve-layer callers.
export { deleteCharacterData };
