import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface EveAccount {
  character_id: number;
  character_name: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes_json: string;
}

/**
 * Get a valid access token for the linked character.
 * Automatically refreshes if expired.
 */
export async function getAccessToken(db: Db, chatId?: number): Promise<{ token: string; characterId: number } | null> {
  const linked = getLinkedCharacter(db, chatId);
  if (!linked) return null;

  const account = db.prepare('SELECT * FROM eve_accounts WHERE character_id = ?').get(linked.characterId) as
    EveAccount | undefined;
  if (!account) return null;

  // Check if token is still valid (with 60s buffer)
  const expiresAt = new Date(account.expires_at + 'Z');
  const now = new Date();
  const bufferMs = 60_000;

  if (expiresAt.getTime() - now.getTime() > bufferMs) {
    return { token: account.access_token, characterId: account.character_id };
  }

  // Refresh the token
  const res = await fetch('https://login.eveonline.com/v2/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${config.eve.clientId}:${config.eve.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
    }),
  });

  if (!res.ok) {
    console.error('[sso] Token refresh failed:', await res.text());
    return null;
  }

  const tokens = (await res.json()) as TokenResponse;

  db.prepare(`
    UPDATE eve_accounts SET
      access_token = ?,
      refresh_token = ?,
      expires_at = datetime('now', '+' || ? || ' seconds')
    WHERE character_id = ?
  `).run(tokens.access_token, tokens.refresh_token, tokens.expires_in, account.character_id);

  return { token: tokens.access_token, characterId: account.character_id };
}

/**
 * Get the currently linked character info and scopes.
 */
export function getLinkedCharacter(
  db: Db,
  chatId?: number,
): { characterId: number; characterName: string; scopes: string[] } | null {
  const characterId = resolveActiveCharacterId(db, chatId);
  if (!characterId) return null;

  const account = db.prepare('SELECT character_id, character_name, scopes_json FROM eve_accounts WHERE character_id = ?')
    .get(characterId) as Pick<EveAccount, 'character_id' | 'character_name' | 'scopes_json'> | undefined;
  if (!account) return null;

  return {
    characterId: account.character_id,
    characterName: account.character_name,
    scopes: JSON.parse(account.scopes_json) as string[],
  };
}

export function listLinkedCharacters(
  db: Db,
  chatId: number,
): Array<{ characterId: number; characterName: string; isActive: boolean }> {
  const activeId = resolveActiveCharacterId(db, chatId);
  const rows = db.prepare(`
    SELECT l.character_id as character_id, a.character_name as character_name
    FROM eve_character_links l
    JOIN eve_accounts a ON a.character_id = l.character_id
    WHERE l.chat_id = ?
    ORDER BY a.character_name COLLATE NOCASE
  `).all(chatId) as Array<{ character_id: number; character_name: string }>;
  return rows.map((row) => ({
    characterId: row.character_id,
    characterName: row.character_name,
    isActive: row.character_id === activeId,
  }));
}

export function linkCharacterToChat(db: Db, chatId: number, characterId: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO eve_character_links (chat_id, character_id) VALUES (?, ?)'
  ).run(chatId, characterId);
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?').run(characterId, chatId);
}

export function setActiveCharacter(db: Db, chatId: number, characterId: number): boolean {
  const link = db.prepare(
    'SELECT 1 FROM eve_character_links WHERE chat_id = ? AND character_id = ?'
  ).get(chatId, characterId);
  if (!link) return false;
  db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?').run(characterId, chatId);
  return true;
}

function resolveActiveCharacterId(db: Db, chatId?: number): number | null {
  if (chatId !== undefined) {
    const row = db.prepare('SELECT active_character_id FROM telegram_sessions WHERE chat_id = ?')
      .get(chatId) as { active_character_id: number | null } | undefined;
    if (row?.active_character_id) return row.active_character_id;

    const linked = db.prepare(
      'SELECT character_id FROM eve_character_links WHERE chat_id = ? ORDER BY linked_at DESC LIMIT 1'
    ).get(chatId) as { character_id: number } | undefined;
    if (linked?.character_id) {
      db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
        .run(linked.character_id, chatId);
      return linked.character_id;
    }
  }

  const fallback = db.prepare('SELECT character_id FROM eve_accounts ORDER BY character_id LIMIT 1').get() as
    | { character_id: number }
    | undefined;
  return fallback?.character_id ?? null;
}
