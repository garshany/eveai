import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { deleteUserProfileArtifact } from '../eve/user-profile-storage.js';
import { refreshUserProfile } from '../eve/user-profile.js';
import { linkCharacterToChat } from '../eve/sso.js';
import { getEveSsoMetadata, verifyEveAccessToken } from '../eve/sso-auth.js';
import type { UserContext } from '../auth/user-resolver.js';
import {
  findPendingAuthRequest,
  markAuthRequestUsed,
} from '../auth/auth-request.js';
import { encryptStoredSecret } from '../auth/secret-storage.js';
import { buildEveAuthorizeUrl } from '../eve/eve-login.js';
import { fetchWithTimeout } from '../eve/http.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('auth');

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
  // GET /auth/eve/login -- short redirect to the full EVE SSO authorize URL.
  // The bots send this short link (the real URL is ~2.1KB, too long for a
  // Discord message/button); it 302s the browser on to EVE.
  app.get<{ Querystring: { state?: string } }>('/auth/eve/login', async (req, reply) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state) {
      return reply.status(400).type('text/html').send(buildNoticePage('Missing login token.'));
    }
    // Validate (do not consume — the callback consumes it) so a stale/expired
    // link gives a clear message instead of bouncing through EVE.
    const pending = findPendingAuthRequest(db, 'eve_sso', state);
    if (!pending) {
      return reply.status(403).type('text/html').send(buildNoticePage('This login link has expired or was already used. Run /eve_login again in the bot.'));
    }
    return reply
      .header('Cache-Control', 'no-store')
      .redirect(buildEveAuthorizeUrl(state));
  });

  // GET /auth/eve/callback -- EVE SSO OAuth callback. Login links are issued
  // by the bots (/eve_login); together with /auth/eve/login, these are the
  // browser-facing auth routes.
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
        log.error('Token exchange failed: %s', errBody);
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
            log.warn('USER.md refresh skipped: %s', result.error);
          } else {
            log.info('USER.md updated: %s', result.data.path);
          }
        })
        .catch((err) => {
          log.warn('USER.md refresh failed: %s', (err as Error).message);
        });

      log.info('Character linked: %s (%d), %d scopes, user_id=%d', payload.name, characterId, scopes.length, ctx.userId);

      return reply.type('text/html').send(buildSuccessPage(payload.name, scopes.length));
    } catch (err) {
      log.error('Callback error: %s', err instanceof Error ? err.message : String(err));
      return reply.status(500).send({ error: 'Authentication failed. Please try /eve_login again.' });
    }
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

function buildSuccessPage(characterName: string, scopeCount: number): string {
  const name = escapeHtml(characterName);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>EVE AI — Character linked</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0e14; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  main { text-align: center; padding: 2rem; }
  h1 { color: #7ee787; }
  p { color: #9da5b4; }
</style></head>
<body><main>
  <h1>Character linked</h1>
  <p><strong>${name}</strong> is now connected with ${scopeCount} scopes.</p>
  <p>You can close this tab and return to the chat.</p>
</main></body>
</html>`;
}

function buildNoticePage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>EVE AI</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0e14; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  main { text-align: center; padding: 2rem; max-width: 32rem; }
  p { color: #9da5b4; }
</style></head>
<body><main><p>${escapeHtml(message)}</p></main></body>
</html>`;
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
