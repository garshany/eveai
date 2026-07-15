import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const PROFILE_DIR = '/tmp/eve-agent-active-fitting-tests';
const { callEsiOperationMock } = vi.hoisted(() => ({
  callEsiOperationMock: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  config: {
    userProfile: {
      path: '/tmp/eve-agent-active-fitting-tests/USER_{chat_id}_{character_id}.md',
      refreshSeconds: 300,
    },
  },
}));

vi.mock('../../src/eve/esi-client.js', () => ({
  callEsiOperation: callEsiOperationMock,
}));

import { resolveActiveFitting } from '../../src/eve/active-fitting.js';
import { resolveUserProfilePath } from '../../src/eve/user-profile-storage.js';

let db: Database.Database;

beforeEach(() => {
  rmSync(PROFILE_DIR, { recursive: true, force: true });
  mkdirSync(PROFILE_DIR, { recursive: true });
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  callEsiOperationMock.mockReset();
});

afterEach(() => {
  db.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
});

describe('active fitting profile persistence', () => {
  it('does not restore an old private profile when scopes change during the ESI request', async () => {
    const characterId = 7001;
    const ctx = { userId: 1, chatId: 10 };
    db.prepare("INSERT INTO users (user_id, display_name, active_character_id) VALUES (1, 'Pilot', ?)")
      .run(characterId);
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (10, 'pilot', ?)")
      .run(characterId);
    db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (?, 'Pilot', 'enc:a', 'enc:r', datetime('now', '+1 hour'), ?, 1)
    `).run(characterId, JSON.stringify(['esi-fittings.read_fittings.v1']));
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (10, ?, 1)')
      .run(characterId);

    const path = resolveUserProfilePath(ctx, characterId);
    writeFileSync(path, '## Wallet\nBalance ISK: 999\n');

    let continueEsi = (): void => {};
    let markEsiStarted = (): void => {};
    const esiStarted = new Promise<void>((resolve) => {
      markEsiStarted = resolve;
    });
    const esiContinuation = new Promise<void>((resolve) => {
      continueEsi = resolve;
    });
    callEsiOperationMock.mockImplementationOnce(async () => {
      markEsiStarted();
      await esiContinuation;
      return {
        ok: true,
        data: [{
          fitting_id: 1,
          name: 'Travel',
          description: '',
          ship_type_id: 587,
          items: [],
        }],
      };
    });

    const fitting = resolveActiveFitting(db, ctx, 587, 'Rifter');
    await esiStarted;
    db.prepare("UPDATE eve_accounts SET scopes_json = '[]' WHERE character_id = ?").run(characterId);
    rmSync(path, { force: true });
    continueEsi();

    await expect(fitting).resolves.toBe('[Rifter, Travel]');
    expect(existsSync(path)).toBe(false);
  });
});
