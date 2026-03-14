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
export async function getAccessToken(db: Db): Promise<{ token: string; characterId: number } | null> {
  const account = db.prepare('SELECT * FROM eve_accounts LIMIT 1').get() as EveAccount | undefined;
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
export function getLinkedCharacter(db: Db): { characterId: number; characterName: string; scopes: string[] } | null {
  const account = db.prepare('SELECT character_id, character_name, scopes_json FROM eve_accounts LIMIT 1').get() as
    | Pick<EveAccount, 'character_id' | 'character_name' | 'scopes_json'>
    | undefined;

  if (!account) return null;

  return {
    characterId: account.character_id,
    characterName: account.character_name,
    scopes: JSON.parse(account.scopes_json) as string[],
  };
}
