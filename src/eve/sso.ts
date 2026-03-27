import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import type { UserContext } from '../auth/user-resolver.js';
import { getUserTelegramChatId } from '../auth/user-resolver.js';
import { decryptStoredSecret, encryptStoredSecret } from '../auth/secret-storage.js';
import { deleteUserProfileArtifact } from './user-profile-storage.js';
import { getEveSsoMetadata, verifyEveAccessToken } from './sso-auth.js';
import { fetchWithTimeout } from './http.js';

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
  user_id?: number | null;
}

const refreshInFlight = new Map<number, Promise<{ token: string; characterId: number } | null>>();

/**
 * Get a valid access token for the linked character.
 * Automatically refreshes if expired.
 */
export async function getAccessToken(db: Db, ctx: UserContext): Promise<{ token: string; characterId: number } | null> {
  const linked = getLinkedCharacter(db, ctx);
  if (!linked) return null;

  const account = db.prepare('SELECT * FROM eve_accounts WHERE character_id = ?').get(linked.characterId) as
    EveAccount | undefined;
  if (!account) return null;
  if (ctx.userId && account.user_id && account.user_id !== ctx.userId) return null;

  const accessToken = decryptStoredSecret(account.access_token, 'eve_access_token');
  const refreshToken = decryptStoredSecret(account.refresh_token, 'eve_refresh_token');

  // Check if token is still valid (with 60s buffer)
  const expiresAt = new Date(account.expires_at + 'Z');
  const now = new Date();
  const bufferMs = 60_000;

  if (expiresAt.getTime() - now.getTime() > bufferMs) {
    return { token: accessToken, characterId: account.character_id };
  }

  // Refresh the token
  const existingRefresh = refreshInFlight.get(account.character_id);
  if (existingRefresh) {
    return await existingRefresh;
  }

  const refreshPromise = refreshAccessToken(db, account, refreshToken);
  refreshInFlight.set(account.character_id, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    refreshInFlight.delete(account.character_id);
  }
}

/**
 * Get the currently linked character info and scopes.
 */
export function getLinkedCharacter(
  db: Db,
  ctx: UserContext,
): { characterId: number; characterName: string; scopes: string[] } | null {
  backfillLegacyOwnership(db, ctx);
  const characterId = resolveActiveCharacterId(db, ctx);
  if (!characterId) return null;

  const account = db.prepare('SELECT character_id, character_name, scopes_json, user_id FROM eve_accounts WHERE character_id = ?')
    .get(characterId) as Pick<EveAccount, 'character_id' | 'character_name' | 'scopes_json' | 'user_id'> | undefined;
  if (!account) return null;
  if (ctx.userId && account.user_id && account.user_id !== ctx.userId) return null;

  return {
    characterId: account.character_id,
    characterName: account.character_name,
    scopes: JSON.parse(account.scopes_json) as string[],
  };
}

export function listLinkedCharacters(
  db: Db,
  ctx: UserContext,
): Array<{ characterId: number; characterName: string; isActive: boolean }> {
  backfillLegacyOwnership(db, ctx);
  const activeId = resolveActiveCharacterId(db, ctx);

  if (ctx.userId) {
    const rows = db.prepare(`
      SELECT DISTINCT l.character_id as character_id, a.character_name as character_name
      FROM eve_character_links l
      JOIN eve_accounts a ON a.character_id = l.character_id
      WHERE l.user_id = ?
      ORDER BY a.character_name COLLATE NOCASE
    `).all(ctx.userId) as Array<{ character_id: number; character_name: string }>;
    if (rows.length > 0) {
      return rows.map((row) => ({
        characterId: row.character_id,
        characterName: row.character_name,
        isActive: row.character_id === activeId,
      }));
    }

    return [];
  }

  if (ctx.chatId !== undefined) {
    const rows = db.prepare(`
      SELECT l.character_id as character_id, a.character_name as character_name
      FROM eve_character_links l
      JOIN eve_accounts a ON a.character_id = l.character_id
      WHERE l.chat_id = ?
      ORDER BY a.character_name COLLATE NOCASE
    `).all(ctx.chatId) as Array<{ character_id: number; character_name: string }>;
    return rows.map((row) => ({
      characterId: row.character_id,
      characterName: row.character_name,
      isActive: row.character_id === activeId,
    }));
  }

  return [];
}

export function linkCharacterToChat(db: Db, ctx: UserContext, characterId: number): void {
  const chatId = ctx.chatId ?? getUserTelegramChatId(db, ctx.userId);

  if (chatId) {
    db.prepare(
      'INSERT OR IGNORE INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)',
    ).run(chatId, characterId, ctx.userId);
    db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
      .run(characterId, chatId);
  }

  if (ctx.userId) {
    db.prepare("UPDATE users SET active_character_id = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(characterId, ctx.userId);
    // Also set user_id on eve_accounts
    db.prepare('UPDATE eve_accounts SET user_id = ? WHERE character_id = ? AND user_id IS NULL')
      .run(ctx.userId, characterId);
  }
}

export function setActiveCharacter(db: Db, ctx: UserContext, characterId: number): boolean {
  backfillLegacyOwnership(db, ctx);

  let linkExists = false;
  if (ctx.userId) {
    linkExists = !!db.prepare(
      'SELECT 1 FROM eve_character_links WHERE user_id = ? AND character_id = ?',
    ).get(ctx.userId, characterId);
  }
  if (!ctx.userId && !linkExists && ctx.chatId !== undefined) {
    linkExists = !!db.prepare(
      'SELECT 1 FROM eve_character_links WHERE chat_id = ? AND character_id = ?',
    ).get(ctx.chatId, characterId);
  }
  if (!linkExists) return false;

  if (ctx.chatId !== undefined) {
    db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
      .run(characterId, ctx.chatId);
  }
  if (ctx.userId) {
    db.prepare("UPDATE users SET active_character_id = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(characterId, ctx.userId);
  }
  return true;
}

export function unlinkCharacter(db: Db, ctx: UserContext, characterId: number): boolean {
  backfillLegacyOwnership(db, ctx);

  let deleted = false;
  if (ctx.userId) {
    const result = db.prepare('DELETE FROM eve_character_links WHERE user_id = ? AND character_id = ?')
      .run(ctx.userId, characterId);
    if (result.changes > 0) deleted = true;
  }
  if (!ctx.userId && !deleted && ctx.chatId !== undefined) {
    const result = db.prepare('DELETE FROM eve_character_links WHERE chat_id = ? AND character_id = ?')
      .run(ctx.chatId, characterId);
    if (result.changes > 0) deleted = true;
  }
  if (!deleted) return false;

  // If this was the active character, clear it
  const active = resolveActiveCharacterId(db, ctx);
  if (active === characterId) {
    if (ctx.chatId !== undefined) {
      db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id = ?').run(ctx.chatId);
    }
    if (ctx.userId) {
      db.prepare("UPDATE users SET active_character_id = NULL, updated_at = datetime('now') WHERE user_id = ?").run(ctx.userId);
    }
  }

  deleteUserProfileArtifact(ctx, characterId);
  cleanupDetachedCharacter(db, characterId);
  return true;
}

function resolveActiveCharacterId(db: Db, ctx: UserContext): number | null {
  if (ctx.userId) {
    const userRow = db.prepare('SELECT active_character_id FROM users WHERE user_id = ?')
      .get(ctx.userId) as { active_character_id: number | null } | undefined;
    if (userRow?.active_character_id) {
      const ownsActiveLink = db.prepare(
        'SELECT 1 FROM eve_character_links WHERE user_id = ? AND character_id = ?',
      ).get(ctx.userId, userRow.active_character_id);
      const ownsActiveAccount = db.prepare(
        'SELECT 1 FROM eve_accounts WHERE user_id = ? AND character_id = ?',
      ).get(ctx.userId, userRow.active_character_id);
      if (ownsActiveLink || ownsActiveAccount) {
        return userRow.active_character_id;
      }
      db.prepare("UPDATE users SET active_character_id = NULL, updated_at = datetime('now') WHERE user_id = ?").run(ctx.userId);
    }
    const linked = db.prepare(
      'SELECT character_id FROM eve_character_links WHERE user_id = ? ORDER BY linked_at DESC LIMIT 1',
    ).get(ctx.userId) as { character_id: number } | undefined;
    if (linked?.character_id) {
      db.prepare("UPDATE users SET active_character_id = ?, updated_at = datetime('now') WHERE user_id = ?")
        .run(linked.character_id, ctx.userId);
      return linked.character_id;
    }
    return null;
  }

  if (ctx.chatId !== undefined) {
    const row = db.prepare('SELECT active_character_id FROM telegram_sessions WHERE chat_id = ?')
      .get(ctx.chatId) as { active_character_id: number | null } | undefined;
    if (row?.active_character_id) return row.active_character_id;

    const linked = db.prepare(
      'SELECT character_id FROM eve_character_links WHERE chat_id = ? ORDER BY linked_at DESC LIMIT 1',
    ).get(ctx.chatId) as { character_id: number } | undefined;
    if (linked?.character_id) {
      db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
        .run(linked.character_id, ctx.chatId);
      return linked.character_id;
    }
  }

  return null;
}

function backfillLegacyOwnership(db: Db, ctx: UserContext): void {
  if (!ctx.userId || ctx.chatId === undefined) {
    return;
  }

  db.prepare('UPDATE eve_character_links SET user_id = ? WHERE chat_id = ? AND user_id IS NULL')
    .run(ctx.userId, ctx.chatId);
  db.prepare('UPDATE agent_threads SET user_id = ? WHERE chat_id = ? AND user_id IS NULL')
    .run(ctx.userId, ctx.chatId);
  db.prepare(`
    UPDATE eve_accounts
    SET user_id = ?
    WHERE user_id IS NULL
      AND character_id IN (
        SELECT character_id
        FROM eve_character_links
        WHERE chat_id = ?
          AND user_id = ?
      )
  `).run(ctx.userId, ctx.chatId, ctx.userId);
}

function cleanupDetachedCharacter(db: Db, characterId: number): void {
  const remaining = db.prepare('SELECT COUNT(*) as count FROM eve_character_links WHERE character_id = ?')
    .get(characterId) as { count: number };
  if (remaining.count > 0) {
    return;
  }

  db.prepare('DELETE FROM eve_accounts WHERE character_id = ?').run(characterId);
}

async function refreshAccessToken(
  db: Db,
  account: EveAccount,
  refreshToken: string,
): Promise<{ token: string; characterId: number } | null> {
  let res: Response;
  try {
    const metadata = await getEveSsoMetadata();
    res = await fetchWithTimeout(metadata.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': config.esi.userAgent,
        Authorization: `Basic ${Buffer.from(`${config.eve.clientId}:${config.eve.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    }, config.eve.requestTimeoutMs);
  } catch (error) {
    console.error('[sso] Token refresh request failed:', (error as Error).message);
    return null;
  }

  if (!res.ok) {
    console.error('[sso] Token refresh failed:', await res.text());
    return null;
  }

  const tokens = (await res.json()) as TokenResponse;
  await verifyEveAccessToken(tokens.access_token);

  db.prepare(`
    UPDATE eve_accounts SET
      access_token = ?,
      refresh_token = ?,
      expires_at = datetime('now', '+' || ? || ' seconds')
    WHERE character_id = ?
  `).run(
    encryptStoredSecret(tokens.access_token, 'eve_access_token'),
    encryptStoredSecret(tokens.refresh_token, 'eve_refresh_token'),
    tokens.expires_in,
    account.character_id,
  );

  return { token: tokens.access_token, characterId: account.character_id };
}
