import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { ALL_REQUESTED_SCOPES } from '../eve/scopes.js';
import { randomUUID } from 'node:crypto';

interface CallbackQuery {
  code?: string;
  state?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface JwtPayload {
  sub: string;          // "CHARACTER:EVE:<character_id>"
  name: string;         // character name
  scp?: string | string[];
  iss?: string;         // should be "login.eveonline.com" or "https://login.eveonline.com"
  exp?: number;         // expiration timestamp
  aud?: string | string[];
}

export function registerAuthRoutes(app: FastifyInstance, db: Db): void {
  // GET /auth/eve/start -- redirect to EVE SSO (browser entry point)
  app.get('/auth/eve/start', async (_req, reply) => {
    const state = randomUUID();

    // Store state for CSRF validation -- use a special chat_id=0 for web-initiated auth
    db.prepare(
      `INSERT INTO telegram_sessions (chat_id, username, oauth_state, last_seen_at)
       VALUES (0, 'web', ?, datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET oauth_state = ?, last_seen_at = datetime('now')`
    ).run(state, state);

    const scopes = ALL_REQUESTED_SCOPES.join(' ');
    const url = new URL('https://login.eveonline.com/v2/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', config.eve.callbackUrl);
    url.searchParams.set('client_id', config.eve.clientId);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', state);

    return reply.redirect(url.toString());
  });

  // GET /auth/eve/callback -- handle OAuth callback
  app.get<{ Querystring: CallbackQuery }>('/auth/eve/callback', async (req, reply) => {
    const { code, state } = req.query;
    if (!code) {
      return reply.status(400).send({ error: 'Missing authorization code' });
    }
    if (!state) {
      return reply.status(400).send({ error: 'Missing state parameter' });
    }

    // Validate CSRF state
    const session = db.prepare(
      'SELECT chat_id FROM telegram_sessions WHERE oauth_state = ?'
    ).get(state) as { chat_id: number } | undefined;

    if (!session) {
      return reply.status(403).send({ error: 'Invalid or expired state parameter. Please try /eve_login again.' });
    }

    // Clear used state
    db.prepare('UPDATE telegram_sessions SET oauth_state = NULL WHERE oauth_state = ?').run(state);

    try {
      // Exchange code for tokens
      const tokenRes = await fetch('https://login.eveonline.com/v2/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${config.eve.clientId}:${config.eve.clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        console.error('[auth] Token exchange failed:', errBody);
        return reply.status(502).send({ error: 'Token exchange failed' });
      }

      const tokens = (await tokenRes.json()) as TokenResponse;

      // Decode and validate JWT
      const payload = decodeJwtPayload(tokens.access_token);
      validateJwt(payload);

      const characterId = extractCharacterId(payload.sub);
      const scopes = Array.isArray(payload.scp) ? payload.scp : payload.scp ? [payload.scp] : [];

      // Store in database
      db.prepare(`
        INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json)
        VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'), ?)
        ON CONFLICT(character_id) DO UPDATE SET
          character_name = excluded.character_name,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at,
          scopes_json = excluded.scopes_json
      `).run(
        characterId,
        payload.name,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_in,
        JSON.stringify(scopes),
      );

      console.log(`[auth] Character linked: ${payload.name} (${characterId}), ${scopes.length} scopes`);
      return reply.type('text/html').send(
        `<h1>Success!</h1><p>Character <strong>${payload.name}</strong> linked with ${scopes.length} scopes. You can close this tab and return to Telegram.</p>`
      );
    } catch (err) {
      console.error('[auth] Callback error:', err);
      return reply.status(500).send({ error: `Auth error: ${(err as Error).message}` });
    }
  });
}

function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload) as JwtPayload;
}

/**
 * Validate JWT claims per EVE SSO docs:
 * - iss must be login.eveonline.com
 * - exp must be in the future
 * - sub must contain CHARACTER:EVE:
 *
 * Note: Full JWKS signature verification would require fetching
 * https://login.eveonline.com/oauth/jwks and verifying RS256.
 * Since the token comes directly from EVE SSO over HTTPS in the
 * token exchange response, claim validation provides reasonable security.
 */
function validateJwt(payload: JwtPayload): void {
  // Validate issuer
  if (payload.iss && payload.iss !== 'login.eveonline.com' && payload.iss !== 'https://login.eveonline.com') {
    throw new Error(`Invalid JWT issuer: ${payload.iss}`);
  }

  // Validate expiration
  if (payload.exp) {
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      throw new Error('JWT token has expired');
    }
  }

  // Validate subject format
  if (!payload.sub || !payload.sub.startsWith('CHARACTER:EVE:')) {
    throw new Error(`Invalid JWT subject: ${payload.sub}`);
  }

  // Validate name exists
  if (!payload.name) {
    throw new Error('JWT missing character name');
  }
}

function extractCharacterId(sub: string): number {
  // sub format: "CHARACTER:EVE:<character_id>"
  const parts = sub.split(':');
  const id = Number(parts[parts.length - 1]);
  if (!id || isNaN(id)) throw new Error(`Invalid character ID in sub: ${sub}`);
  return id;
}
