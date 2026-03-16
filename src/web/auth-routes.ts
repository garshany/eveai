import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { ALL_REQUESTED_SCOPES } from '../eve/scopes.js';
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { refreshUserProfile } from '../eve/user-profile.js';
import { linkCharacterToChat } from '../eve/sso.js';

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
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

const JWKS = createRemoteJWKSet(new URL('https://login.eveonline.com/oauth/jwks'));

export function registerAuthRoutes(app: FastifyInstance, db: Db): void {
  // GET /auth/eve/start -- redirect to EVE SSO (browser entry point)
  app.get('/auth/eve/start', async (_req, reply) => {
    if (!config.security.allowWebAuth) {
      return reply.status(403).send({ error: 'Web auth disabled. Use /eve_login from Telegram.' });
    }
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
    const { code, state, error, error_description } = req.query;
    if (error) {
      return reply.status(400).send({ error: `SSO error: ${error_description ?? error}` });
    }
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
          redirect_uri: config.eve.callbackUrl,
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        console.error('[auth] Token exchange failed:', errBody);
        return reply.status(502).send({ error: 'Token exchange failed' });
      }

      const tokens = (await tokenRes.json()) as TokenResponse;

      // Verify JWT (signature + claims)
      const payload = await verifyAccessToken(tokens.access_token);

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

      if (session.chat_id && session.chat_id > 0) {
        linkCharacterToChat(db, session.chat_id, characterId);
      }

      void refreshUserProfile(db, session.chat_id)
        .then((result) => {
          if (!result.ok) {
            console.warn(`[auth] USER.md refresh skipped: ${result.error}`);
          } else {
            console.log(`[auth] USER.md updated: ${result.data.path}`);
          }
        })
        .catch((err) => {
          console.warn(`[auth] USER.md refresh failed: ${(err as Error).message}`);
        });

      console.log(`[auth] Character linked: ${payload.name} (${characterId}), ${scopes.length} scopes`);
      return reply.type('text/html').send(
        `<h1>Success!</h1><p>Character <strong>${payload.name}</strong> linked with ${scopes.length} scopes. You can close this tab and return to Telegram.</p>`
      );
    } catch (err) {
      console.error('[auth] Callback error:', err);
      return reply.status(500).send({ error: `Auth error: ${(err as Error).message}` });
    }
  });

  // Alias: GET /callback -- for EVE apps registered with http://localhost:PORT/callback
  app.get<{ Querystring: CallbackQuery }>('/callback', async (req, reply) => {
    // Redirect to the main callback handler
    const qs = new URLSearchParams();
    if (req.query.code) qs.set('code', req.query.code);
    if (req.query.state) qs.set('state', req.query.state);
    if (req.query.error) qs.set('error', req.query.error);
    if (req.query.error_description) qs.set('error_description', req.query.error_description);
    return reply.redirect(`/auth/eve/callback?${qs.toString()}`);
  });
}

/**
 * Verify JWT signature and claims per EVE SSO docs:
 * - iss must be login.eveonline.com
 * - aud must include client_id and "EVE Online"
 * - exp must be in the future (jwtVerify enforces)
 * - sub must contain CHARACTER:EVE:
 */
async function verifyAccessToken(token: string): Promise<JwtPayload> {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: ['login.eveonline.com', 'https://login.eveonline.com'],
  });

  const data = payload as unknown as JwtPayload;
  const aud = Array.isArray(data.aud) ? data.aud : data.aud ? [data.aud] : [];

  if (!aud.includes(config.eve.clientId) || !aud.includes('EVE Online')) {
    throw new Error(`Invalid JWT audience: ${aud.join(', ') || 'missing'}`);
  }

  if (!data.sub || !data.sub.startsWith('CHARACTER:EVE:')) {
    throw new Error(`Invalid JWT subject: ${data.sub}`);
  }

  if (!data.name) {
    throw new Error('JWT missing character name');
  }

  return data;
}

function extractCharacterId(sub: string): number {
  // sub format: "CHARACTER:EVE:<character_id>"
  const parts = sub.split(':');
  const id = Number(parts[parts.length - 1]);
  if (!id || isNaN(id)) throw new Error(`Invalid character ID in sub: ${sub}`);
  return id;
}
