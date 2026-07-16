import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const { callEsiOperationMock, getCapabilitiesMock, getLinkedCharacterMock } = vi.hoisted(() => ({
  callEsiOperationMock: vi.fn(),
  getCapabilitiesMock: vi.fn(),
  getLinkedCharacterMock: vi.fn(),
}));

vi.mock('../../src/eve/esi-client.js', () => ({ callEsiOperation: callEsiOperationMock }));
vi.mock('../../src/eve/capabilities.js', () => ({ getEveCapabilities: getCapabilitiesMock }));
vi.mock('../../src/eve/sso.js', () => ({ getLinkedCharacter: getLinkedCharacterMock }));

import { loadWebPilotProfile } from '../../src/web/pilot-profile.js';

let db: Database.Database;
const linked = { characterId: 9001, characterName: 'Test Pilot', scopes: ['scope.a'] };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, data_json TEXT); CREATE TABLE sde_types (type_id INTEGER PRIMARY KEY, name TEXT);');
  db.prepare('INSERT INTO sde_systems VALUES (30000142, ?, ?)').run('Jita', JSON.stringify({ securityStatus: 0.9 }));
  db.prepare('INSERT INTO sde_types VALUES (17715, ?)').run('Gila');
  getLinkedCharacterMock.mockReset().mockReturnValue(linked);
  getCapabilitiesMock.mockReset().mockResolvedValue({
    allowedNamespaces: ['esi_characters_online', 'esi_characters_location', 'esi_characters_ship', 'esi_characters_skills', 'esi_characters_skillqueue', 'esi_characters_wallet'],
  });
  callEsiOperationMock.mockReset().mockImplementation(async (_db: unknown, operation: string) => {
    const data: Record<string, unknown> = {
      get_characters_character_id: { name: 'Test Pilot', corporation_id: 77, alliance_id: 88, birthday: '2020-01-01T00:00:00Z', security_status: 1.2 },
      get_characters_character_id_online: { online: true },
      get_characters_character_id_location: { solar_system_id: 30000142 },
      get_characters_character_id_ship: { ship_type_id: 17715, ship_name: 'Explorer' },
      get_characters_character_id_skills: { total_sp: 12_345_678 },
      get_characters_character_id_skillqueue: [{ finish_date: '2026-08-01T00:00:00Z' }],
      get_characters_character_id_wallet: 987_654.32,
      get_corporations_corporation_id: { name: 'Corp', ticker: 'CRP' },
      get_alliances_alliance_id: { name: 'Alliance', ticker: 'ALLY' },
    };
    return { ok: true, data: data[operation] };
  });
});

describe('web pilot profile', () => {
  it('builds a narrow active-character DTO without credentials', async () => {
    const result = await loadWebPilotProfile(db, { userId: 1, chatId: -2_000_000_000, notificationCapability: 'web' });
    expect(result.stale).toBe(false);
    expect(result.profile).toMatchObject({
      character: { id: 9001, name: 'Test Pilot', portraitUrl: '/api/web/profile/portrait' },
      corporation: { id: 77, name: 'Corp', ticker: 'CRP' },
      alliance: { id: 88, name: 'Alliance', ticker: 'ALLY' },
      online: true,
      location: { solarSystemName: 'Jita', security: 0.9 },
      ship: { typeName: 'Gila', name: 'Explorer' },
      skills: { totalSp: 12_345_678, queued: 1 },
      wallet: { balance: 987_654.32 },
    });
    expect(JSON.stringify(result)).not.toMatch(/token|scope\.a|refresh/i);
  });

  it('drops a response when the active character changes during parallel ESI reads', async () => {
    getLinkedCharacterMock
      .mockReturnValueOnce(linked)
      .mockReturnValueOnce({ ...linked, characterId: 9002 });
    const result = await loadWebPilotProfile(db, { userId: 1, chatId: -2_000_000_000, notificationCapability: 'web' });
    expect(result).toEqual({ profile: null, stale: true });
  });
});
