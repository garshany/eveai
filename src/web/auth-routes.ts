import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { deleteUserProfileArtifact } from '../eve/user-profile-storage.js';
import { ALL_REQUESTED_SCOPES } from '../eve/scopes.js';
import { refreshUserProfile } from '../eve/user-profile.js';
import { linkCharacterToChat } from '../eve/sso.js';
import { getEveSsoMetadata, verifyEveAccessToken } from '../eve/sso-auth.js';
import { getOrCreateUser, type UserContext } from '../auth/user-resolver.js';
import { consumeTelegramLoginNonce, parseTelegramLoginQuery, verifyTelegramLogin } from '../auth/telegram-login.js';
import {
  buildLogoutCookie,
  buildSessionCookie,
  createWebSession,
  deleteWebSession,
  SESSION_COOKIE_NAME,
} from '../auth/session.js';
import { consumeHandoffToken } from '../auth/handoff.js';
import { resolveUserFromWebSession } from '../auth/user-resolver.js';
import {
  createAuthRequestToken,
  findPendingAuthRequest,
  markAuthRequestUsed,
} from '../auth/auth-request.js';
import { encryptStoredSecret } from '../auth/secret-storage.js';
import { isTelegramUserAllowed } from '../telegram/access.js';
import { fetchWithTimeout } from '../eve/http.js';

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

export function registerAuthRoutes(app: FastifyInstance, db: Db): void {
  // GET /auth/telegram/callback -- Telegram Login Widget verification
  app.get<{ Querystring: Record<string, string> }>('/auth/telegram/callback', async (req, reply) => {
    const data = parseTelegramLoginQuery(req.query);
    if (!data) {
      return reply.status(400).send({ error: 'Invalid Telegram login data' });
    }

    if (!verifyTelegramLogin(data)) {
      return reply.status(403).send({ error: 'Telegram login verification failed' });
    }

    if (!consumeTelegramLoginNonce(db, String(req.query.nonce ?? ''))) {
      return reply.status(403).send({ error: 'Telegram login challenge expired or already used' });
    }

    if (!isTelegramUserAllowed(data.id, config.telegram.allowedUserId)) {
      return reply.status(403).send({ error: 'Access denied' });
    }

    const userId = getOrCreateUser(db, data.id, data.username, data.first_name);
    const sessionId = createWebSession(db, userId);
    const cookie = buildSessionCookie(sessionId, config.web.sessionTtlHours, req.headers);

    return reply
      .header('Cache-Control', 'no-store')
      .header('Set-Cookie', cookie)
      .redirect('/app');
  });

  // GET /auth/eve/start -- requires web session, redirects to EVE SSO
  app.get('/auth/eve/start', async (req, reply) => {
    const userId = resolveSessionUser(db, req);
    if (!userId) {
      return reply.status(401).send({ error: 'Not authenticated. Login via Telegram first.' });
    }

    const state = createAuthRequestToken(db, 'eve_sso', userId, {
      ttlSeconds: 600,
    });

    const scopes = ALL_REQUESTED_SCOPES.join(' ');
    const metadata = await getEveSsoMetadata();
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', config.eve.callbackUrl);
    url.searchParams.set('client_id', config.eve.clientId);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', state);

    return reply.redirect(url.toString());
  });

  // GET /auth/eve/callback -- handle OAuth callback (both bot and web origins)
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

    const authRequest = findPendingAuthRequest(db, 'eve_sso', state);
    if (!authRequest) {
      return reply.status(403).send({ error: 'Invalid or expired state parameter. Please try again.' });
    }

    markAuthRequestUsed(db, 'eve_sso', state);

    const userId = authRequest.user_id;
    const chatId = authRequest.chat_id ?? null;

    try {
      // Exchange code for tokens
      const metadata = await getEveSsoMetadata();
      const tokenRes = await fetchWithTimeout(metadata.token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': config.esi.userAgent,
          Authorization: `Basic ${Buffer.from(`${config.eve.clientId}:${config.eve.clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: config.eve.callbackUrl,
        }),
      }, config.eve.requestTimeoutMs);

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        console.error('[auth] Token exchange failed:', errBody);
        return reply.status(502).send({ error: 'Token exchange failed' });
      }

      const tokens = (await tokenRes.json()) as TokenResponse;
      const payload = await verifyEveAccessToken(tokens.access_token);
      const characterId = extractCharacterId(payload.sub);
      const scopes = Array.isArray(payload.scp) ? payload.scp : payload.scp ? [payload.scp] : [];

      // Store in database
      db.prepare(`
        INSERT INTO eve_accounts (character_id, character_name, access_token, refresh_token, expires_at, scopes_json, user_id)
        VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'), ?, ?)
        ON CONFLICT(character_id) DO UPDATE SET
          character_name = excluded.character_name,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at,
          scopes_json = excluded.scopes_json,
          user_id = excluded.user_id
      `).run(
        characterId,
        payload.name,
        encryptStoredSecret(tokens.access_token, 'eve_access_token'),
        encryptStoredSecret(tokens.refresh_token, 'eve_refresh_token'),
        tokens.expires_in,
        JSON.stringify(scopes),
        userId,
      );

      // Build UserContext for linking
      const ctx: UserContext = chatId ? { userId, chatId } : { userId };

      await reassignCharacterOwnership(db, ctx.userId, characterId);
      linkCharacterToChat(db, ctx, characterId);

      void refreshUserProfile(db, ctx)
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

      console.log(`[auth] Character linked: ${payload.name} (${characterId}), ${scopes.length} scopes, user_id=${ctx.userId}`);

      // If from web, redirect to dashboard
      const sessionUser = resolveSessionUser(db, req);
      if (sessionUser) {
        return reply.redirect('/app');
      }

      return reply.type('text/html').send(
        `<h1>Success!</h1><p>Character <strong>${escapeHtml(payload.name)}</strong> linked with ${scopes.length} scopes. You can close this tab and return to Telegram.</p>`,
      );
    } catch (err) {
      console.error('[auth] Callback error:', err);
      return reply.status(500).send({ error: `Auth error: ${(err as Error).message}` });
    }
  });

  // POST /auth/tg-handoff/exchange -- one-time token from bot -> web session
  app.post<{ Body: { token?: string } }>('/auth/tg-handoff/exchange', async (req, reply) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!token) {
      return reply.status(400).send({ error: 'Missing token' });
    }

    const userId = consumeHandoffToken(db, token);
    if (!userId) {
      return reply.status(403).send({ error: 'Invalid or expired handoff token' });
    }

    const sessionId = createWebSession(db, userId);
    const cookie = buildSessionCookie(sessionId, config.web.sessionTtlHours, req.headers);

    return reply
      .header('Cache-Control', 'no-store')
      .header('Set-Cookie', cookie)
      .send({ ok: true });
  });

  // POST /auth/logout
  app.post('/auth/logout', async (req, reply) => {
    const sessionId = extractSessionCookie(req);
    if (sessionId) {
      deleteWebSession(db, sessionId);
    }
    return reply
      .header('Cache-Control', 'no-store')
      .header('Set-Cookie', buildLogoutCookie(req.headers))
      .send({ ok: true });
  });

  // Alias: GET /callback -- for EVE apps registered with http://localhost:PORT/callback
  app.get<{ Querystring: CallbackQuery }>('/callback', async (req, reply) => {
    const qs = new URLSearchParams();
    if (req.query.code) qs.set('code', req.query.code);
    if (req.query.state) qs.set('state', req.query.state);
    if (req.query.error) qs.set('error', req.query.error);
    if (req.query.error_description) qs.set('error_description', req.query.error_description);
    return reply.redirect(`/auth/eve/callback?${qs.toString()}`);
  });
}

function resolveSessionUser(db: Db, req: { headers: Record<string, string | string[] | undefined> }): number | null {
  const sessionId = extractSessionCookie(req);
  if (!sessionId) return null;
  return resolveUserFromWebSession(db, sessionId);
}

function extractSessionCookie(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;

  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      return trimmed.slice(SESSION_COOKIE_NAME.length + 1);
    }
  }
  return null;
}

function extractCharacterId(sub: string): number {
  const parts = sub.split(':');
  const id = Number(parts[parts.length - 1]);
  if (!id || isNaN(id)) throw new Error(`Invalid character ID in sub: ${sub}`);
  return id;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function reassignCharacterOwnership(db: Db, userId: number, characterId: number): Promise<void> {
  const staleLinks = db.prepare(`
    SELECT chat_id, user_id
    FROM eve_character_links
    WHERE character_id = ?
      AND COALESCE(user_id, 0) != ?
  `).all(characterId, userId) as Array<{ chat_id: number; user_id: number | null }>;

  for (const link of staleLinks) {
    db.prepare('UPDATE telegram_sessions SET active_character_id = NULL WHERE chat_id = ? AND active_character_id = ?')
      .run(link.chat_id, characterId);
    if (link.user_id) {
      db.prepare('UPDATE users SET active_character_id = NULL WHERE user_id = ? AND active_character_id = ?')
        .run(link.user_id, characterId);
    }
    await deleteUserProfileArtifact({ userId: link.user_id ?? 0, chatId: link.chat_id }, characterId);
  }

  db.prepare('DELETE FROM eve_character_links WHERE character_id = ? AND COALESCE(user_id, 0) != ?')
    .run(characterId, userId);
  db.prepare('UPDATE eve_accounts SET user_id = ? WHERE character_id = ?').run(userId, characterId);
}
