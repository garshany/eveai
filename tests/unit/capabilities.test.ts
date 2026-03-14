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
  it('returns unauthenticated with only public profiles', () => {
    const caps = getEveCapabilities(db, 'check wallet');
    expect(caps.authenticated).toBe(false);
    expect(caps.characterId).toBeNull();
    expect(caps.allowedProfiles).toContain('eve-public');
    expect(caps.allowedProfiles).not.toContain('eve-character');
    expect(caps.allowedProfiles).not.toContain('eve-wallet');
  });

  it('returns all 10 profiles when ALL scopes granted', () => {
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(123, 'Pilot', 'tok', 'ref', JSON.stringify(ALL_REQUESTED_SCOPES));

    const caps = getEveCapabilities(db, 'check all');
    expect(caps.authenticated).toBe(true);
    expect(caps.characterName).toBe('Pilot');
    expect(caps.allowedProfiles).toHaveLength(10);
    expect(caps.allowedProfiles).toContain('eve-public');
    expect(caps.allowedProfiles).toContain('eve-character');
    expect(caps.allowedProfiles).toContain('eve-wallet');
    expect(caps.allowedProfiles).toContain('eve-assets');
    expect(caps.allowedProfiles).toContain('eve-market');
    expect(caps.allowedProfiles).toContain('eve-industry');
    expect(caps.allowedProfiles).toContain('eve-contracts');
    expect(caps.allowedProfiles).toContain('eve-mail');
    expect(caps.allowedProfiles).toContain('eve-corp');
    expect(caps.allowedProfiles).toContain('eve-ui');
    expect(Object.keys(caps.missingProfiles)).toHaveLength(0);
  });

  it('reports missing profiles with partial scopes', () => {
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(123, 'Pilot', 'tok', 'ref', JSON.stringify([
      'esi-wallet.read_character_wallet.v1',
      'esi-mail.read_mail.v1',
    ]));

    const caps = getEveCapabilities(db, 'check');
    expect(caps.authenticated).toBe(true);
    expect(caps.allowedProfiles).toContain('eve-public');
    expect(caps.allowedProfiles).toContain('eve-wallet');
    expect(caps.allowedProfiles).toContain('eve-mail');
    expect(caps.allowedProfiles).not.toContain('eve-character');
    expect(caps.allowedProfiles).not.toContain('eve-industry');
    expect(caps.allowedProfiles).not.toContain('eve-corp');
    // Verify missing scopes are reported
    expect(caps.missingProfiles['eve-character']).toBeDefined();
    expect(caps.missingProfiles['eve-corp']).toBeDefined();
    expect(caps.missingProfiles['eve-character'].length).toBeGreaterThan(0);
  });
});
