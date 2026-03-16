import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 1 },
    openai: { apiKey: 'test', model: 'test' },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '0.0.0.0' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    security: { allowWebAuth: true },
  },
}));

import { getEveCapabilities } from '../../src/eve/capabilities.js';
import { ALL_REQUESTED_SCOPES } from '../../src/eve/scopes.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('get_eve_capabilities', () => {
  it('returns unauthenticated with only public namespaces', async () => {
    const caps = await getEveCapabilities(db, 'check wallet');
    expect(caps.authenticated).toBe(false);
    expect(caps.characterId).toBeNull();
    expect(caps.allowedNamespaces).toContain('esi_markets_orders');
    expect(caps.allowedNamespaces).not.toContain('esi_characters_wallet');
  });

  it('returns authenticated namespaces when all requested scopes granted', async () => {
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(123, 'Pilot', 'tok', 'ref', JSON.stringify(ALL_REQUESTED_SCOPES));

    const caps = await getEveCapabilities(db, 'check all');
    expect(caps.authenticated).toBe(true);
    expect(caps.characterName).toBe('Pilot');
    expect(caps.allowedNamespaces).toContain('esi_characters_wallet');
    expect(caps.allowedNamespaces.some((entry) => entry.startsWith('esi_ui_'))).toBe(true);
    expect(Object.values(caps.deniedNamespaces).every((missing) => Array.isArray(missing))).toBe(true);
    expect(caps.accessibleOperations).toBeGreaterThan(50);
  });

  it('reports denied namespaces with partial scopes', async () => {
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(123, 'Pilot', 'tok', 'ref', JSON.stringify([
      'esi-wallet.read_character_wallet.v1',
      'esi-mail.read_mail.v1',
      'esi-mail.organize_mail.v1',
      'esi-mail.send_mail.v1',
    ]));

    const caps = await getEveCapabilities(db, 'check');
    expect(caps.authenticated).toBe(true);
    expect(caps.allowedNamespaces).toContain('esi_characters_wallet');
    expect(caps.allowedNamespaces.some((entry) => entry.includes('mail'))).toBe(true);
    expect(Object.keys(caps.deniedNamespaces).length).toBeGreaterThan(0);
    expect(Object.values(caps.deniedNamespaces).some((missing) => missing.length > 0)).toBe(true);
  });

  it('allows market namespaces when market scopes are granted', async () => {
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(123, 'Pilot', 'tok', 'ref', JSON.stringify([
      'esi-markets.read_character_orders.v1',
    ]));

    const caps = await getEveCapabilities(db, 'market');
    expect(caps.allowedNamespaces.some((entry) => entry.startsWith('esi_markets_'))).toBe(true);
    expect(caps.accessibleOperations).toBeGreaterThan(0);
  });
});
