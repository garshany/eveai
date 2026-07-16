import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import {
  buildAgentTurnContext,
  captureTurnIdentity,
  isTurnIdentityCurrent,
} from '../../src/agent/turn-context.js';

describe('immutable agent turn context', () => {
  it('detects active-character and scope changes without mutating the snapshot', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
      .run(7, 'Pilot', 9001);
    db.prepare('INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)').run(
      9001, 'Alpha', 'x', 'x', '2099-01-01 00:00:00', '["esi-location.read_location.v1"]', 7,
      9002, 'Bravo', 'x', 'x', '2099-01-01 00:00:00', '["esi-wallet.read_character_wallet.v1"]', 7,
    );
    db.prepare('INSERT INTO telegram_sessions (chat_id, active_character_id) VALUES (?, ?)').run(70, 9001);
    db.prepare('INSERT INTO eve_character_links (chat_id, user_id, character_id) VALUES (?, ?, ?), (?, ?, ?)').run(
      70, 7, 9001,
      70, 7, 9002,
    );
    const ctx = { userId: 7, chatId: 70 };
    const identity = captureTurnIdentity(db, ctx);
    const turn = buildAgentTurnContext(identity, {
      requestId: 'req-1', threadId: 'thread-1', locale: 'Russian', startedAt: 100, deadlineMs: 1_000,
    });

    expect(turn).toMatchObject({ characterId: 9001, deadlineAt: 1_100 });
    expect(isTurnIdentityCurrent(db, ctx, identity)).toBe(true);
    db.prepare('UPDATE users SET active_character_id = ? WHERE user_id = ?').run(9002, 7);
    expect(isTurnIdentityCurrent(db, ctx, identity)).toBe(false);
    expect(turn.characterId).toBe(9001);

    db.prepare(
      'UPDATE users SET active_character_id = ?, active_character_version = active_character_version + 1 WHERE user_id = ?',
    ).run(9001, 7);
    expect(isTurnIdentityCurrent(db, ctx, identity)).toBe(false);
    db.close();
  });
});
