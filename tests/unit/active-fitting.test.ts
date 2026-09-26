import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

import { resolveActiveFitting, writeManualFitting } from '../../src/eve/active-fitting.js';
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

  it('groups modules by their ESI string slot flags instead of dropping them', async () => {
    // Regression: ESI fittings return `flag` as a string enum ("HiSlot0",
    // "MedSlot0", …). The code once typed it as a number and compared numeric
    // ranges, so every module resolved to the "Other" bucket — which is not in
    // the slot order — and the persisted fitting lost all of its modules.
    const characterId = 7002;
    const ctx = { userId: 1, chatId: 11 };
    db.prepare("INSERT INTO users (user_id, display_name, active_character_id) VALUES (1, 'Pilot', ?)")
      .run(characterId);
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (11, 'pilot', ?)")
      .run(characterId);
    db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (?, 'Pilot', 'enc:a', 'enc:r', datetime('now', '+1 hour'), ?, 1)
    `).run(characterId, JSON.stringify(['esi-fittings.read_fittings.v1']));
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (11, ?, 1)')
      .run(characterId);

    for (const [typeId, name] of [
      [2929, 'Damage Control II'],
      [12058, '125mm Gatling AutoCannon II'],
      [5975, 'Warp Scrambler II'],
      [31724, 'Small Ancillary Armor Repairer'],
      [31159, 'Small Projectile Collision Accelerator I'],
      [2456, 'Warrior II'],
      [12625, 'Nanite Repair Paste'],
    ] as const) {
      db.prepare('INSERT INTO sde_types (type_id, name, group_id, data_json) VALUES (?, ?, 1, ?)')
        .run(typeId, name, JSON.stringify({ type_id: typeId, name }));
    }

    const path = resolveUserProfilePath(ctx, characterId);
    writeFileSync(path, '## Wallet\nBalance ISK: 999\n');

    callEsiOperationMock.mockResolvedValueOnce({
      ok: true,
      data: [{
        fitting_id: 9,
        name: 'Brawler',
        description: '',
        ship_type_id: 587,
        items: [
          { type_id: 12058, flag: 'HiSlot0', quantity: 1 },
          { type_id: 5975, flag: 'MedSlot0', quantity: 1 },
          { type_id: 2929, flag: 'LoSlot0', quantity: 1 },
          { type_id: 31724, flag: 'LoSlot1', quantity: 1 },
          { type_id: 31159, flag: 'RigSlot0', quantity: 1 },
          { type_id: 2456, flag: 'DroneBay', quantity: 3 },
          { type_id: 12625, flag: 'Cargo', quantity: 10 },
        ],
      }],
    });

    const fitting = await resolveActiveFitting(db, ctx, 587, 'Rifter');

    expect(fitting).not.toBeNull();
    // Every module must survive, grouped under its real slot.
    expect(fitting).toContain('125mm Gatling AutoCannon II');
    expect(fitting).toContain('Warp Scrambler II');
    expect(fitting).toContain('Damage Control II');
    expect(fitting).toContain('Small Ancillary Armor Repairer');
    expect(fitting).toContain('Small Projectile Collision Accelerator I');
    expect(fitting).toContain('Warrior II x3');
    expect(fitting).toContain('Nanite Repair Paste x10');
    // Slots are emitted High → Mid → Low → Rig → … → Cargo.
    const text = fitting ?? '';
    expect(text.indexOf('125mm Gatling AutoCannon II')).toBeLessThan(text.indexOf('Warp Scrambler II'));
    expect(text.indexOf('Warp Scrambler II')).toBeLessThan(text.indexOf('Damage Control II'));
    expect(text.indexOf('Small Projectile Collision Accelerator I')).toBeLessThan(text.indexOf('Warrior II x3'));

    // And it is persisted into USER.md rather than being silently emptied.
    const saved = readFileSync(path, 'utf-8');
    expect(saved).toContain('## Active Fitting');
    expect(saved).toContain('125mm Gatling AutoCannon II');
  });

  it('writeManualFitting reports a missing profile and persists once it exists (no access() pre-check)', async () => {
    const characterId = 7003;
    const ctx = { userId: 1, chatId: 13 };
    db.prepare("INSERT INTO users (user_id, display_name, active_character_id) VALUES (1, 'Pilot', ?)")
      .run(characterId);
    db.prepare("INSERT INTO telegram_sessions (chat_id, username, active_character_id) VALUES (13, 'pilot', ?)")
      .run(characterId);
    db.prepare(`
      INSERT INTO eve_accounts (
        character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id
      ) VALUES (?, 'Pilot', 'enc:a', 'enc:r', datetime('now', '+1 hour'), '[]', 1)
    `).run(characterId);
    db.prepare('INSERT INTO eve_character_links (chat_id, character_id, user_id) VALUES (13, ?, 1)')
      .run(characterId);

    const path = resolveUserProfilePath(ctx, characterId);

    // No USER.md yet → the missing-profile message is returned (the outcome that
    // the removed access() check used to detect via a check-then-use race).
    await expect(writeManualFitting(db, ctx, '[Rifter, Manual]'))
      .resolves.toEqual({ ok: false, error: 'USER.md not found. Refresh profile first.' });

    // Once the profile exists, the manual fit is persisted.
    writeFileSync(path, '## Wallet\nBalance ISK: 1\n');
    await expect(writeManualFitting(db, ctx, '[Rifter, Manual]')).resolves.toEqual({ ok: true });
    const saved = readFileSync(path, 'utf-8');
    expect(saved).toContain('## Active Fitting');
    expect(saved).toContain('[Rifter, Manual]');
  });
});
