import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const profileDir = '/tmp/eve-agent-user-profile-tests';

vi.mock('../../src/config.js', () => ({
  config: {
    telegram: { botToken: 'test', allowedUserId: 0 },
    openai: { apiKey: 'test', model: 'test' },
    eve: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost:3000/auth/eve/callback' },
    server: { port: 3000, host: '127.0.0.1' },
    db: { path: ':memory:' },
    sde: { dataDir: './data/sde' },
    web: { baseUrl: 'http://localhost:3000', sessionTtlHours: 720, handoffTtlSeconds: 300 },
    userProfile: { path: '/tmp/eve-agent-user-profile-tests/USER_{chat_id}_{character_id}.md', refreshSeconds: 300 },
  },
}));

import { buildUserMarkdown, readUserProfile } from '../../src/eve/user-profile.js';

let db: Database.Database;

beforeEach(() => {
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(10, 'u1', 7001);
  db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (?, ?, ?)").run(11, 'u2', 7001);
  db.prepare(`
    INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
    VALUES (?, ?, ?, ?, datetime('now', '+1200 seconds'), ?)
  `).run(7001, 'Pilot', 'tok', 'ref', '[]');
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(10, 7001);
  db.prepare('INSERT INTO eve_character_links (chat_id, character_id) VALUES (?, ?)').run(11, 7001);
});

afterEach(() => {
  db.close();
  rmSync(profileDir, { recursive: true, force: true });
});

describe('readUserProfile', () => {
  it('reads only the profile file for the current chat and character pair', () => {
    writeFileSync(join(profileDir, 'USER_10_7001.md'), 'profile for chat 10');

    expect(readUserProfile(db, { userId: 0, chatId: 10 })).toBe('profile for chat 10');
    expect(readUserProfile(db, { userId: 0, chatId: 11 })).toBeNull();
  });

  it('keeps full gameplay detail in USER.md while sanitizing text fields', () => {
    const markdown = buildUserMarkdown({
      updatedAt: '2026-03-27T20:00:00.000Z',
      character: {
        name: 'Pilot<script>',
        id: 7001,
        birthday: '2020-01-01',
        securityStatus: 2.5,
        corporationId: 1001,
        corporationName: 'Corp<unsafe>',
        allianceId: 2002,
        allianceName: 'Alliance',
        factionId: 3003,
        factionName: 'Faction',
      },
      status: {
        isOnline: true,
        lastLogin: '2026-03-27T19:00:00.000Z',
        lastLogout: '2026-03-27T18:00:00.000Z',
        systemId: 30000142,
        systemName: 'Jita',
        stationId: 60003760,
        stationName: 'Jita IV',
        structureId: 1024,
        shipName: 'My <Ship>',
        shipTypeId: 587,
        shipTypeName: 'Rifter',
      },
      skills: {
        totalSp: 1234567,
        unallocatedSp: 7654,
        trained: [{ name: 'Mining<script>', level: 5 }],
      },
      attributes: {
        intelligence: 20,
        memory: 21,
        perception: 22,
        willpower: 23,
        charisma: 24,
        bonusRemaps: 1,
        lastRemapDate: '2026-03-01',
      },
      skillQueue: [{ name: 'Cybernetics<script>', finishedLevel: 5, finishDate: '2026-03-29T00:00:00.000Z' }],
      implants: [{ name: 'Ocular Filter<script>', typeId: 1 }],
      clones: [{ location: 'Jita<script>', implants: ['Halo<script>'] }],
      fittings: [{ name: 'Travel<script>', shipType: 'Astero<script>' }],
      wallet: { balance: 999999.12 },
    });

    expect(markdown).toContain('## Wallet');
    expect(markdown).toContain('Balance ISK');
    expect(markdown).toContain('## Saved Fittings');
    expect(markdown).toContain('## Jump Clones');
    expect(markdown).toContain('## Active Implants');
    expect(markdown).toContain('## Attributes');
    expect(markdown).toContain('## Skill Queue');
    expect(markdown).toContain('## Skills');
    expect(markdown).toContain('## Status');
    expect(markdown).not.toContain('<script>');
  });
});
