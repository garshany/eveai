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
    // No other profiles should be available without auth
    expect(caps.allowedProfiles).not.toContain('eve-character');
    expect(caps.allowedProfiles).not.toContain('eve-wallet');
  });

  it('returns full capabilities when all scopes granted', () => {
    db.prepare(`
      INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
      VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
    `).run(123, 'Pilot', 'tok', 'ref', JSON.stringify([
      // eve-character scopes
      'esi-skills.read_skills.v1',
      'esi-skills.read_skillqueue.v1',
      'esi-clones.read_clones.v1',
      'esi-clones.read_implants.v1',
      'esi-location.read_location.v1',
      'esi-location.read_ship_type.v1',
      'esi-location.read_online.v1',
      'esi-characters.read_contacts.v1',
      'esi-characters.read_standings.v1',
      'esi-characters.read_notifications.v1',
      'esi-fittings.read_fittings.v1',
      'esi-killmails.read_killmails.v1',
      'esi-bookmarks.read_character_bookmarks.v1',
      // eve-wallet
      'esi-wallet.read_character_wallet.v1',
      // eve-assets
      'esi-assets.read_assets.v1',
      // eve-market
      'esi-markets.read_character_orders.v1',
      // eve-industry
      'esi-industry.read_character_jobs.v1',
      'esi-characters.read_blueprints.v1',
      'esi-planets.manage_planets.v1',
      // eve-contracts
      'esi-contracts.read_character_contracts.v1',
      // eve-mail
      'esi-mail.read_mail.v1',
      // eve-corp
      'esi-corporations.read_corporation_membership.v1',
      'esi-corporations.read_structures.v1',
      'esi-wallet.read_corporation_wallets.v1',
      'esi-assets.read_corporation_assets.v1',
      // eve-ui
      'esi-ui.open_window.v1',
      'esi-ui.write_waypoint.v1',
    ]));

    const caps = getEveCapabilities(db, 'check all');
    expect(caps.authenticated).toBe(true);
    expect(caps.characterName).toBe('Pilot');
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
    expect(caps.missingProfiles['eve-character']).toBeDefined();
    expect(caps.missingProfiles['eve-character'].length).toBeGreaterThan(0);
  });
});
