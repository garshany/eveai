import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      callbackUrl: 'http://localhost:3000/auth/eve/callback',
      requestTimeoutMs: 5000,
    },
    esi: {
      baseUrl: 'https://esi.evetech.net/latest/',
      specUrl: 'https://esi.evetech.net/latest/swagger.json',
      catalogCachePath: './data/cache/esi-swagger.json',
      compatibilityDate: '2026-03-15',
      userAgent: 'EVEAI/4.0 (+https://github.com/example/eveai; contact=operator@example.com)',
      maxPages: 5,
      backoffMaxSeconds: 1,
      requestTimeoutMs: 5000,
      retryMaxAttempts: 1,
    },
    characterSync: {
      maxPages: 50,
      fallbackTtlSeconds: 3600,
      errorRetrySeconds: 120,
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    userProfile: { path: './data/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720 },
  },
}));

import {
  datasetsForTables,
  ensureCharacterDatasetsFresh,
  getCharacterDatasetStatuses,
} from '../../src/eve/character-sync.js';
import { deleteCharacterData } from '../../src/db/character-datastore.js';
import { unlinkCharacter } from '../../src/eve/sso.js';
import type { Db } from '../../src/db/sqlite.js';

const CHARACTER_ID = 90000001;
const USER_ID = 1;
const CHAT_ID = 100;
const ALL_SCOPES = [
  'esi-assets.read_assets.v1',
  'esi-wallet.read_character_wallet.v1',
  'esi-markets.read_character_orders.v1',
  'esi-contracts.read_character_contracts.v1',
  'esi-skills.read_skills.v1',
  'esi-skills.read_skillqueue.v1',
  'esi-clones.read_clones.v1',
  'esi-clones.read_implants.v1',
  'esi-characters.read_standings.v1',
  'esi-location.read_location.v1',
  'esi-location.read_ship_type.v1',
  'esi-location.read_online.v1',
];

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      Expires: new Date(Date.now() + 3600_000).toUTCString(),
      ...headers,
    },
  });
}

function linkCharacter(scopes: string[] = ALL_SCOPES): void {
  db.prepare('INSERT INTO users (display_name, active_character_id) VALUES (?, ?)')
    .run('pilot', CHARACTER_ID);
  db.prepare('INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, 'pilot', CHARACTER_ID);
  db.prepare(`
    INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
    VALUES (?, ?, 'access-token', 'refresh-token', datetime('now', '+1 hour'), ?, ?)
  `).run(CHARACTER_ID, 'Pilot One', JSON.stringify(scopes), USER_ID);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
    .run(CHAT_ID, CHARACTER_ID, USER_ID);
}

beforeEach(() => {
  vi.useRealTimers();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  db.close();
});

describe('character datastore sync', () => {
  it('walks every assets page beyond ESI_MAX_PAGES using the sync page cap', async () => {
    linkCharacter();
    const totalPages = 7; // interactive ESI_MAX_PAGES is 5 — sync must not stop there
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page') ?? '1');
      return jsonResponse(
        [{ item_id: page, type_id: 34 + page, location_id: 60003760, location_type: 'station', location_flag: 'Hangar', quantity: page, is_singleton: false }],
        { 'X-Pages': String(totalPages), 'Last-Modified': 'Wed, 25 Mar 2026 00:00:00 GMT' },
      );
    });

    const statuses = await ensureCharacterDatasetsFresh(db as Db, { userId: USER_ID }, ['assets']);

    expect(fetchMock).toHaveBeenCalledTimes(totalPages);
    expect(statuses).toEqual([
      expect.objectContaining({ dataset: 'assets', status: 'ok', rows_synced: totalPages }),
    ]);
    const rows = db.prepare('SELECT item_id, type_id FROM character_assets WHERE character_id = ? ORDER BY item_id')
      .all(CHARACTER_ID) as Array<{ item_id: number; type_id: number }>;
    expect(rows.map((row) => row.item_id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('serves the cached dataset within its TTL without refetching', async () => {
    linkCharacter();
    fetchMock.mockResolvedValue(jsonResponse(123456.78));

    await ensureCharacterDatasetsFresh(db as Db, { userId: USER_ID }, ['wallet']);
    const callsAfterFirstSync = fetchMock.mock.calls.length;
    const statuses = await ensureCharacterDatasetsFresh(db as Db, { userId: USER_ID }, ['wallet']);

    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirstSync);
    expect(statuses[0]).toMatchObject({ dataset: 'wallet', status: 'ok' });
    expect(db.prepare('SELECT balance FROM character_wallet WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ balance: 123456.78 });
  });

  it('marks datasets without the required scope as no_scope and skips the network', async () => {
    linkCharacter(ALL_SCOPES.filter((scope) => scope !== 'esi-assets.read_assets.v1'));

    const statuses = await ensureCharacterDatasetsFresh(db as Db, { userId: USER_ID }, ['assets']);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(statuses[0]).toMatchObject({ dataset: 'assets', status: 'no_scope' });
    expect(statuses[0]?.error).toContain('esi-assets.read_assets.v1');
  });

  it('degrades per dataset: a failing endpoint keeps stale rows and does not block others', async () => {
    linkCharacter();
    db.prepare('INSERT INTO character_wallet (character_id, balance, synced_at) VALUES (?, 42, datetime(\'now\'))')
      .run(CHARACTER_ID);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/wallet/')) {
        return new Response(JSON.stringify({ error: 'upstream broken' }), { status: 500 });
      }
      return jsonResponse([
        { item_id: 9, type_id: 587, location_id: 1, location_type: 'station', location_flag: 'Hangar', quantity: 2, is_singleton: true },
      ], { 'X-Pages': '1' });
    });

    const statuses = await ensureCharacterDatasetsFresh(db as Db, { userId: USER_ID }, ['assets', 'wallet']);

    expect(statuses).toEqual([
      expect.objectContaining({ dataset: 'assets', status: 'ok' }),
      expect.objectContaining({ dataset: 'wallet', status: 'error' }),
    ]);
    // Stale wallet row preserved, assets synced.
    expect(db.prepare('SELECT balance FROM character_wallet WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ balance: 42 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM character_assets WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ c: 1 });

    // The error backoff suppresses an immediate retry.
    const calls = fetchMock.mock.calls.length;
    await ensureCharacterDatasetsFresh(db as Db, { userId: USER_ID }, ['wallet']);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it('upserts the wallet journal so rows beyond the page window survive refreshes', async () => {
    linkCharacter();
    db.prepare(`
      INSERT INTO character_wallet_journal (character_id, journal_id, date, ref_type, amount, data_json, synced_at)
      VALUES (?, 999, '2020-01-01T00:00:00Z', 'player_donation', 5, '{}', datetime('now'))
    `).run(CHARACTER_ID);
    fetchMock.mockResolvedValue(jsonResponse([
      { id: 1, date: '2026-03-25T00:00:00Z', ref_type: 'market_escrow', amount: -10, balance: 90 },
      { id: 2, date: '2026-03-25T01:00:00Z', ref_type: 'bounty_prizes', amount: 50, balance: 140 },
    ], { 'X-Pages': '1' }));

    await ensureCharacterDatasetsFresh(db as Db, { userId: USER_ID }, ['wallet_journal']);

    const ids = (db.prepare(
      'SELECT journal_id FROM character_wallet_journal WHERE character_id = ? ORDER BY journal_id',
    ).all(CHARACTER_ID) as Array<{ journal_id: number }>).map((row) => row.journal_id);
    expect(ids).toEqual([1, 2, 999]);
  });

  it('syncs presence by merging location, ship, and online under their own scopes', async () => {
    linkCharacter();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/location/')) return jsonResponse({ solar_system_id: 30000142, station_id: 60003760 });
      if (url.includes('/ship/')) return jsonResponse({ ship_type_id: 587, ship_name: 'Winnie', ship_item_id: 11 });
      if (url.includes('/online/')) return jsonResponse({ online: true, last_login: '2026-03-25T00:00:00Z' });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const statuses = await ensureCharacterDatasetsFresh(db as Db, { userId: USER_ID }, ['presence']);

    expect(statuses[0]).toMatchObject({ dataset: 'presence', status: 'ok' });
    expect(db.prepare('SELECT solar_system_id, ship_type_id, ship_name, online FROM character_presence WHERE character_id = ?')
      .get(CHARACTER_ID))
      .toEqual({ solar_system_id: 30000142, ship_type_id: 587, ship_name: 'Winnie', online: 1 });
  });

  it('maps profile tables to their backing datasets', () => {
    expect(datasetsForTables(['character_assets'])).toEqual(['assets']);
    expect(datasetsForTables(['character_profile'])).toEqual(['skills', 'clones']);
    expect(datasetsForTables(['character_sync_state'])).toEqual([]);
    expect(datasetsForTables(['character_assets', 'character_wallet', 'unknown_table']))
      .toEqual(['assets', 'wallet']);
  });
});

describe('character datastore lifecycle deletion', () => {
  function seedCharacterRows(): void {
    db.prepare(`
      INSERT INTO character_assets (character_id, item_id, type_id, location_id, data_json, synced_at)
      VALUES (?, 1, 34, 1, '{}', datetime('now'))
    `).run(CHARACTER_ID);
    db.prepare('INSERT INTO character_wallet (character_id, balance, synced_at) VALUES (?, 10, datetime(\'now\'))')
      .run(CHARACTER_ID);
    db.prepare(`
      INSERT INTO character_sync_state (character_id, dataset, status, rows_synced, synced_at)
      VALUES (?, 'assets', 'ok', 1, datetime('now'))
    `).run(CHARACTER_ID);
  }

  function characterRowCount(): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM character_assets WHERE character_id = ?').get(CHARACTER_ID) as { c: number }).c
      + (db.prepare('SELECT COUNT(*) AS c FROM character_wallet WHERE character_id = ?').get(CHARACTER_ID) as { c: number }).c
      + (db.prepare('SELECT COUNT(*) AS c FROM character_sync_state WHERE character_id = ?').get(CHARACTER_ID) as { c: number }).c;
  }

  it('deleteCharacterData removes rows from every character table', () => {
    linkCharacter();
    seedCharacterRows();
    expect(characterRowCount()).toBeGreaterThan(0);

    deleteCharacterData(db as Db, CHARACTER_ID);

    expect(characterRowCount()).toBe(0);
  });

  it('unlinkCharacter cascades to the materialized profile', async () => {
    linkCharacter();
    seedCharacterRows();

    const removed = await unlinkCharacter(db as Db, { userId: USER_ID }, CHARACTER_ID);

    expect(removed).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS c FROM eve_accounts WHERE character_id = ?').get(CHARACTER_ID))
      .toEqual({ c: 0 });
    expect(characterRowCount()).toBe(0);
  });

  it('keeps the materialized profile while another link to the character survives', async () => {
    linkCharacter();
    // A second user's lane linked to the same character.
    db.prepare('INSERT INTO users (display_name) VALUES (?)').run('alt');
    db.prepare('INSERT INTO telegram_sessions (chat_id, username) VALUES (?, ?)').run(200, 'alt');
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)')
      .run(200, CHARACTER_ID, 2);
    seedCharacterRows();

    const removed = await unlinkCharacter(db as Db, { userId: USER_ID, chatId: CHAT_ID }, CHARACTER_ID);

    expect(removed).toBe(true);
    expect(characterRowCount()).toBeGreaterThan(0);
  });
});
