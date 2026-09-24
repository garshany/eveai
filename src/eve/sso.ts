import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import type { UserContext } from '../auth/user-resolver.js';
import { getUserTelegramChatId } from '../auth/user-resolver.js';
import { decryptStoredSecret, encryptStoredSecret } from '../auth/secret-storage.js';
import { deleteCharacterData } from '../db/character-datastore.js';
import {
  deleteUserProfileArtifact,
  withUserProfileAuthorizationLock,
} from './user-profile-storage.js';
import { getEveSsoMetadata, verifyEveAccessToken } from './sso-auth.js';
import { fetchRetrying } from './http.js';
import { createHash } from 'node:crypto';

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
 * Backoff for refresh tokens that EVE SSO rejected permanently (400
 * invalid_grant / 401). Kept in memory, keyed by character_id and a SHA-256
 * fingerprint of the refresh token the rejection applied to:
 * - a re-login writes a new refresh_token, the fingerprint no longer matches,
 *   so the backoff is ignored without any callback-side bookkeeping;
 * - no schema change or extra write path in SSO callbacks;
 * - a process restart costs at most one extra SSO call per dead token.
 * Transient failures (network, 429, 5xx) never create an entry.
 */
const REFRESH_BACKOFF_BASE_MS = 5 * 60_000;
const REFRESH_BACKOFF_MAX_MS = 6 * 60 * 60_000;
const refreshBackoff = new Map<number, { tokenHash: string; failures: number; until: number }>();

function refreshTokenFingerprint(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

function activeRefreshBackoff(characterId: number, refreshToken: string, now = Date.now()): boolean {
  const entry = refreshBackoff.get(characterId);
  if (!entry) return false;
  if (entry.tokenHash !== refreshTokenFingerprint(refreshToken)) {
    refreshBackoff.delete(characterId);
    return false;
  }
  return entry.until > now;
}

function recordRefreshRejection(characterId: number, refreshToken: string, now = Date.now()): number {
  const tokenHash = refreshTokenFingerprint(refreshToken);
  const previous = refreshBackoff.get(characterId);
  const failures = previous && previous.tokenHash === tokenHash ? previous.failures + 1 : 1;
  const delayMs = Math.min(REFRESH_BACKOFF_MAX_MS, REFRESH_BACKOFF_BASE_MS * 2 ** (failures - 1));
  refreshBackoff.set(characterId, { tokenHash, failures, until: now + delayMs });
  return delayMs;
}

export function resetRefreshBackoffForTests(): void {
  refreshBackoff.clear();
}

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

  let accessToken: string;
  let refreshToken: string;
  try {
    accessToken = decryptStoredSecret(account.access_token, 'eve_access_token');
    refreshToken = decryptStoredSecret(account.refresh_token, 'eve_refresh_token');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      '[sso] stored token decrypt failed for character=%d user=%s chat=%s: %s',
      account.character_id,
      ctx.userId ?? 'none',
      ctx.chatId ?? 'none',
      message,
    );
    return null;
  }

  // Check if token is still valid (with 60s buffer)
  const expiresAt = new Date(account.expires_at + 'Z');
  const now = new Date();
  const bufferMs = 60_000;

  if (expiresAt.getTime() - now.getTime() > bufferMs) {
    return { token: accessToken, characterId: account.character_id };
  }

  // A refresh token SSO already rejected is not retried until the backoff
  // expires or a re-login stores a different refresh token.
  if (activeRefreshBackoff(account.character_id, refreshToken)) {
    return null;
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
  if (
    ctx.chatId !== undefined
    && !db.prepare('SELECT 1 FROM telegram_sessions WHERE chat_id = ?').get(ctx.chatId)
  ) return null;
  if (ctx.userId > 0 && !db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(ctx.userId)) {
    return null;
  }
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
  const activeId = resolveActiveCharacterId(db, unpinned(ctx));

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

  if (chatId !== null && chatId !== undefined) {
    db.prepare(
      'INSERT OR IGNORE INTO eve_character_links (chat_id, character_id, user_id) VALUES (?, ?, ?)',
    ).run(chatId, characterId, ctx.userId);
    db.prepare('UPDATE telegram_sessions SET active_character_id = ? WHERE chat_id = ?')
      .run(characterId, chatId);
  }

  if (ctx.userId) {
    db.prepare("UPDATE users SET active_character_id = ?, active_character_version = active_character_version + 1, updated_at = datetime('now') WHERE user_id = ?")
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
    db.prepare("UPDATE users SET active_character_id = ?, active_character_version = active_character_version + 1, updated_at = datetime('now') WHERE user_id = ?")
      .run(characterId, ctx.userId);
  }
  return true;
}

export async function unlinkCharacter(db: Db, ctx: UserContext, characterId: number): Promise<boolean> {
  return await withUserProfileAuthorizationLock(characterId, async () => {
    backfillLegacyOwnership(db, ctx);
    const linkedChats = ctx.userId
      ? db.prepare('SELECT chat_id FROM eve_character_links WHERE user_id = ? AND character_id = ?')
        .all(ctx.userId, characterId) as Array<{ chat_id: number }>
      : [];

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
    const active = resolveActiveCharacterId(db, unpinned(ctx));
    if (active === characterId) {
      if (ctx.chatId !== undefined) {
        db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id = ?').run(ctx.chatId);
      }
      if (ctx.userId) {
        db.prepare("UPDATE users SET active_character_id = NULL, active_character_version = active_character_version + 1, updated_at = datetime('now') WHERE user_id = ?").run(ctx.userId);
      }
    }

    if (ctx.userId) {
      for (const link of linkedChats) {
        await deleteUserProfileArtifact({ userId: ctx.userId, chatId: link.chat_id }, characterId);
      }
      await deleteUserProfileArtifact({ userId: ctx.userId }, characterId);
    } else {
      await deleteUserProfileArtifact(ctx, characterId);
    }
    cleanupDetachedCharacter(db, characterId);
    return true;
  });
}

function resolveActiveCharacterId(db: Db, ctx: UserContext): number | null {
  if (ctx.characterId !== undefined) {
    return resolvePinnedCharacterId(db, ctx, ctx.characterId);
  }
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
      db.prepare("UPDATE users SET active_character_id = NULL, active_character_version = active_character_version + 1, updated_at = datetime('now') WHERE user_id = ?").run(ctx.userId);
    }
    const linked = db.prepare(
      'SELECT character_id FROM eve_character_links WHERE user_id = ? ORDER BY linked_at DESC LIMIT 1',
    ).get(ctx.userId) as { character_id: number } | undefined;
    if (linked?.character_id) {
      db.prepare("UPDATE users SET active_character_id = ?, active_character_version = active_character_version + 1, updated_at = datetime('now') WHERE user_id = ?")
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

/**
 * A pinned character is honored only when this user (or, for a legacy
 * chat-only context, this chat) owns it. Never mutates the active selection.
 */
function resolvePinnedCharacterId(db: Db, ctx: UserContext, characterId: number): number | null {
  if (!Number.isSafeInteger(characterId) || characterId <= 0) return null;
  if (ctx.userId) {
    const ownsLink = db.prepare(
      'SELECT 1 FROM eve_character_links WHERE user_id = ? AND character_id = ?',
    ).get(ctx.userId, characterId);
    const ownsAccount = db.prepare(
      'SELECT 1 FROM eve_accounts WHERE user_id = ? AND character_id = ?',
    ).get(ctx.userId, characterId);
    return ownsLink || ownsAccount ? characterId : null;
  }
  if (ctx.chatId !== undefined) {
    const linked = db.prepare(
      'SELECT 1 FROM eve_character_links WHERE chat_id = ? AND character_id = ?',
    ).get(ctx.chatId, characterId);
    return linked ? characterId : null;
  }
  return null;
}

/** The user's real active selection, ignoring any per-call character pin. */
function unpinned(ctx: UserContext): UserContext {
  if (ctx.characterId === undefined) return ctx;
  const rest = { ...ctx };
  delete rest.characterId;
  return rest;
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

  // Private profile rows must not outlive the account they were synced for.
  deleteCharacterData(db, characterId);
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
    res = await fetchRetrying(metadata.token_endpoint, {
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
    }, { maxAttempts: 2, backoffMaxMs: 3000, timeoutMs: config.eve.requestTimeoutMs });
  } catch (error) {
    console.error('[sso] Token refresh request failed:', (error as Error).message);
    return null;
  }

  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      const delayMs = recordRefreshRejection(account.character_id, refreshToken);
      console.error(
        '[sso] Token refresh rejected: HTTP %d for character=%d; pausing refresh for %d min or until re-login',
        res.status,
        account.character_id,
        Math.round(delayMs / 60_000),
      );
      return null;
    }
    console.error('[sso] Token refresh failed: HTTP %d for character=%d', res.status, account.character_id);
    return null;
  }

  refreshBackoff.delete(account.character_id);

  // getAccessToken's contract is "token or null": a malformed body or a JWT
  // that fails verification must not escape as an exception. Only the error
  // message is logged, never token material.
  let tokens: TokenResponse;
  let payload: Awaited<ReturnType<typeof verifyEveAccessToken>>;
  try {
    tokens = (await res.json()) as TokenResponse;
    if (!tokens || typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
      console.error('[sso] Token refresh returned an invalid payload for character=%d', account.character_id);
      return null;
    }
    payload = await verifyEveAccessToken(tokens.access_token);
  } catch (error) {
    console.error('[sso] Token refresh response rejected for character=%d: %s',
      account.character_id, error instanceof Error ? error.name : 'unknown error');
    return null;
  }

  // Ensure the refreshed token is still for the same character before storing
  // it under this row — never serve character B's token from A's account.
  const refreshedCharacterId = Number(payload.sub.split(':').at(-1));
  if (!Number.isFinite(refreshedCharacterId) || refreshedCharacterId !== account.character_id) {
    console.error('[sso] Refresh returned a token for a different character (expected %d, got %s) — rejecting',
      account.character_id, payload.sub);
    return null;
  }

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
