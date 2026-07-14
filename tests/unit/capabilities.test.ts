import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: {
      clientId: 'test',
      clientSecret: 'test',
      callbackUrl: 'http://localhost:3000/auth/eve/callback',
      requestTimeoutMs: 5000,
    },
    esi: {
      baseUrl: 'https://esi.evetech.net/latest/',
      specUrl: 'https://esi.evetech.net/latest/swagger.json',
      catalogCachePath: './data/cache/esi-swagger.json',
      compatibilityDate: '2026-03-15',
      userAgent: 'EVEAI/3.2 (+https://github.com/example/eveai; contact=operator@example.com)',
      maxPages: 5,
      backoffMaxSeconds: 10,
      requestTimeoutMs: 5000,
      retryMaxAttempts: 2,
    },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, handoffTtlSeconds: 300 },
  },
}));

import { clearCapabilitySnapshots, getEveCapabilities } from '../../src/eve/capabilities.js';
import { ALL_REQUESTED_SCOPES } from '../../src/eve/scopes.js';
import { callEsiOperation } from '../../src/eve/esi-client.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  clearCapabilitySnapshots();
});

afterEach(() => {
  clearCapabilitySnapshots();
  vi.unstubAllGlobals();
  db.close();
});

describe('get_eve_capabilities', () => {
  it('returns unauthenticated with only public namespaces', async () => {
    const caps = await getEveCapabilities(db, 'check wallet', { userId: 0 });
    expect(caps.authenticated).toBe(false);
    expect(caps.characterId).toBeNull();
    expect(caps.allowedNamespaces).toContain('esi_markets_orders');
    expect(caps.allowedNamespaces).not.toContain('esi_characters_wallet');
  });

  it('returns authenticated namespaces when all requested scopes granted', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(1, 'pilot', 123);
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(123, 'Pilot', 'tok', 'ref', JSON.stringify(ALL_REQUESTED_SCOPES));
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 123);

    const caps = await getEveCapabilities(db, 'check all', { userId: 0, chatId: 1 });
    expect(caps.authenticated).toBe(true);
    expect(caps.characterName).toBe('Pilot');
    expect(caps.allowedNamespaces).toContain('esi_characters_wallet');
    expect(caps.allowedNamespaces.some((entry) => entry.startsWith('esi_ui_'))).toBe(true);
    expect(Object.values(caps.deniedNamespaces).every((missing) => Array.isArray(missing))).toBe(true);
    expect(caps.accessibleOperations).toBeGreaterThan(50);
  });

  it('reports denied namespaces with partial scopes', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(1, 'pilot', 123);
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(123, 'Pilot', 'tok', 'ref', JSON.stringify([
      'esi-wallet.read_character_wallet.v1',
      'esi-mail.read_mail.v1',
      'esi-mail.organize_mail.v1',
      'esi-mail.send_mail.v1',
    ]));
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 123);

    const caps = await getEveCapabilities(db, 'check', { userId: 0, chatId: 1 });
    expect(caps.authenticated).toBe(true);
    expect(caps.allowedNamespaces).toContain('esi_characters_wallet');
    expect(caps.allowedNamespaces.some((entry) => entry.includes('mail'))).toBe(true);
    expect(Object.keys(caps.deniedNamespaces).length).toBeGreaterThan(0);
    expect(Object.values(caps.deniedNamespaces).some((missing) => missing.length > 0)).toBe(true);
  });

  it('allows market namespaces when market scopes are granted', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(1, 'pilot', 123);
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(123, 'Pilot', 'tok', 'ref', JSON.stringify([
      'esi-markets.read_character_orders.v1',
    ]));
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 123);

    const caps = await getEveCapabilities(db, 'market', { userId: 0, chatId: 1 });
    expect(caps.allowedNamespaces.some((entry) => entry.startsWith('esi_markets_'))).toBe(true);
    expect(caps.accessibleOperations).toBeGreaterThan(0);
  });

  it('rejects private ESI without a fresh capability handshake', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(1, 'pilot', 123);
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(123, 'Pilot', 'tok', 'ref', JSON.stringify(ALL_REQUESTED_SCOPES));
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 123);

    const result = await callEsiOperation(db, 'post_ui_openwindow_information', { target_id: 60003760 }, { userId: 0, chatId: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected private ESI call to be rejected');
    }
    expect(result.status).toBe(428);
    expect(result.error).toContain('get_eve_capabilities');
  });

  it('allows private ESI after a fresh capability handshake', async () => {
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(1, 'pilot', 123);
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(123, 'Pilot', 'tok', 'ref', JSON.stringify(ALL_REQUESTED_SCOPES));
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(1, 123);

    await getEveCapabilities(db, 'ui_info', { userId: 0, chatId: 1 });

    const realFetch = global.fetch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes('/ui/openwindow/information')) {
        return new Response(null, { status: 204 });
      }
      return await realFetch(input as RequestInfo, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callEsiOperation(db, 'post_ui_openwindow_information', { target_id: 60003760 }, { userId: 0, chatId: 1 });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });
});
