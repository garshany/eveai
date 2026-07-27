import type { FastifyInstance } from 'fastify';
import { rmSync } from 'node:fs';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { deleteCharacterData } from '../db/character-datastore.js';
import {
  resolveUserProfilePath,
  withUserProfileAuthorizationLock,
} from '../eve/user-profile-storage.js';
import { refreshUserProfile } from '../eve/user-profile.js';
import { linkCharacterToChat } from '../eve/sso.js';
import { getEveSsoMetadata, verifyEveAccessToken } from '../eve/sso-auth.js';
import type { UserContext } from '../auth/user-resolver.js';
import {
  findPendingAuthRequest,
  markAuthRequestUsed,
  recordAuthRequestConsent,
} from '../auth/auth-request.js';
import { encryptStoredSecret } from '../auth/secret-storage.js';
import { buildEveAuthorizeUrl } from '../eve/eve-login.js';
import { fetchWithTimeout } from '../eve/http.js';
import { createLogger } from '../observability/logger.js';
import {
  EVE_CONSENT_VERSION,
  parseEveConsentForm,
} from './eve-consent.js';
import { buildLocalizedEveConsentPage, type ConsentLocale } from './localized-eve-consent-page.js';
import { withWebLaneAuthorizationLocks } from './web-lane-lock.js';
import { WEB_CHAT_ID_START } from './web-session.js';

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
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        const parsed: Record<string, string | string[]> = {};
        for (const [key, value] of new URLSearchParams(String(body))) {
          const current = parsed[key];
          parsed[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
        }
        done(null, parsed);
      },
    );
  }

  // Every platform gets the same disclosure in one explicitly selected language. The full EVE SSO URL
  // is created only after the player selects an allowlisted least-privilege
  // scope set and explicitly acknowledges how the data is used.
  app.get<{ Querystring: { state?: string; language?: string } }>('/auth/eve/login', async (req, reply) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const locale: ConsentLocale = req.query.language === 'en' ? 'en' : 'ru';
    if (!state) {
      return reply.status(400).type('text/html').send(buildNoticePage('Missing login token.'));
    }
    // Validate (do not consume — the callback consumes it) so a stale/expired
    // link gives a clear message instead of bouncing through EVE.
    const pending = findPendingAuthRequest(db, 'eve_sso', state);
    if (!pending) {
      return reply.status(403).type('text/html').send(buildNoticePage('This login link has expired or was already used. Run /eve_login again in the bot.'));
    }
    if (!pending.consented_at || !pending.requestedScopes || pending.consent_version !== EVE_CONSENT_VERSION) {
      return reply
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(buildLocalizedEveConsentPage(state, locale));
    }
    return reply
      .header('Cache-Control', 'no-store')
      .redirect(buildEveAuthorizeUrl(state, pending.requestedScopes));
  });

  app.post<{ Body: unknown }>('/auth/eve/consent', async (req, reply) => {
    const values = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const state = typeof values.state === 'string' ? values.state : '';
    const locale: ConsentLocale = values.language === 'en' ? 'en' : 'ru';
    const pending = state ? findPendingAuthRequest(db, 'eve_sso', state) : null;
    if (!pending) {
      return reply.status(403).type('text/html').send(buildNoticePage('This login link has expired or was already used.'));
    }
    const consent = parseEveConsentForm(values);
    if (!consent) {
      return reply
        .status(400)
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(buildLocalizedEveConsentPage(
          state,
          locale,
          locale === 'ru'
            ? 'Подтвердите согласие и используйте только доступные категории.'
            : 'Confirm consent and use only the available categories.',
        ));
    }
    const recorded = recordAuthRequestConsent(db, 'eve_sso', state, {
      version: EVE_CONSENT_VERSION,
      language: consent.language,
      scopes: consent.scopes,
    });
    if (!recorded) {
      return reply.status(403).type('text/html').send(buildNoticePage('This login link has expired or was already used.'));
    }
    return reply
      .header('Cache-Control', 'no-store')
      .redirect(`/auth/eve/login?state=${encodeURIComponent(state)}`);
  });

  // GET /auth/eve/callback -- EVE SSO OAuth callback. Login links are issued
  // by the bots (/eve_login); together with /auth/eve/login, these are the
  // browser-facing auth routes.
  app.get<{ Querystring: CallbackQuery }>('/auth/eve/callback', async (req, reply) => {
    const { code, state, error, error_description } = req.query;
    if (error) {
      const deniedRequest = state ? findPendingAuthRequest(db, 'eve_sso', state) : null;
      if (deniedRequest && state) {
        markAuthRequestUsed(db, 'eve_sso', state);
        const redirect = safeAppRedirect(deniedRequest.redirect_url);
        if (redirect) return reply.redirect(buildAppAuthRedirect(redirect, 'denied'));
      }
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
    if (!authRequest.consented_at || !authRequest.requestedScopes || authRequest.consent_version !== EVE_CONSENT_VERSION) {
      return reply.status(403).send({ error: 'EVE data access was not acknowledged. Please start the login flow again.' });
    }

    markAuthRequestUsed(db, 'eve_sso', state);

    const userId = authRequest.user_id;
    const chatId = authRequest.chat_id ?? null;
    const appRedirect = safeAppRedirect(authRequest.redirect_url);

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
        log.error('Token exchange failed category=upstream_http status=%d', tokenRes.status);
        return reply.status(502).send({ error: 'Token exchange failed' });
      }

      const tokens = (await tokenRes.json()) as TokenResponse;
      const payload = await verifyEveAccessToken(tokens.access_token);
      const characterId = extractCharacterId(payload.sub);
      const scopes = Array.isArray(payload.scp) ? payload.scp : payload.scp ? [payload.scp] : [];
      const requestedScopeSet = new Set(authRequest.requestedScopes);
      if (scopes.some((scope) => !requestedScopeSet.has(scope))) {
        return reply.status(403).send({ error: 'EVE SSO granted an unexpected scope. Please start the login flow again.' });
      }
      const ownerInput = {
        requestedUserId: userId,
        chatId,
        characterId,
        isBrowserFlow: Boolean(appRedirect),
      };
      // Validate browser ownership before any profile is removed. Browser
      // flows then hold the locks of every lane the merge may touch before the
      // character lock and revalidate inside the transaction, keeping owner
      // and character membership stable.
      const preliminaryPlan = planBrowserSsoOwner(db, ownerInput);
      const lockedChatIds = chatId === null
        ? []
        : [chatId, ...(preliminaryPlan.kind === 'merge' ? preliminaryPlan.orphanChatIds : [])];
      const persistCutover = async (): Promise<UserContext> => await withUserProfileAuthorizationLock(characterId, async () => {
        const persistAuthorization = db.transaction((): UserContext => {
          const ownerPlan = planBrowserSsoOwner(db, ownerInput);
          if (ownerPlan.kind === 'merge') {
            // The orphan set was computed before the lane locks were taken. A
            // lane that appeared since is outside the held locks, so the merge
            // cannot safely rewrite it — fail and let the user retry.
            const held = new Set(lockedChatIds);
            const orphanChatIds = listOrphanedWebLaneIds(db, ownerPlan.existingUserId, ownerPlan.chatId);
            if (orphanChatIds.some((orphanChatId) => !held.has(orphanChatId))) {
              throw new Error('Browser SSO orphan lanes changed during sign-in');
            }
          }
          deleteCharacterProfileArtifacts(db, characterId);
          const resolvedUserId = applyBrowserSsoOwnerPlan(db, ownerPlan);
          db.prepare(`
            INSERT INTO eve_accounts (
              character_id, character_name, access_token, refresh_token, expires_at,
              scopes_json, consent_version, consent_language, consented_at, user_id
            )
            VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'), ?, ?, ?, ?, ?)
            ON CONFLICT(character_id) DO UPDATE SET
              character_name = excluded.character_name,
              access_token = excluded.access_token,
              refresh_token = excluded.refresh_token,
              expires_at = excluded.expires_at,
              scopes_json = excluded.scopes_json,
              consent_version = excluded.consent_version,
              consent_language = excluded.consent_language,
              consented_at = excluded.consented_at,
              user_id = excluded.user_id
          `).run(
            characterId,
            payload.name,
            encryptStoredSecret(tokens.access_token, 'eve_access_token'),
            encryptStoredSecret(tokens.refresh_token, 'eve_refresh_token'),
            tokens.expires_in,
            JSON.stringify(scopes),
            authRequest.consent_version,
            authRequest.consent_language,
            authRequest.consented_at,
            resolvedUserId,
          );

          const persistedContext: UserContext = chatId !== null
            ? { userId: resolvedUserId, chatId }
            : { userId: resolvedUserId };
          reassignCharacterOwnership(db, persistedContext.userId, characterId);
          linkCharacterToChat(db, persistedContext, characterId);
          return persistedContext;
        });
        return persistAuthorization.immediate();
      });
      const ctx = appRedirect && chatId !== null
        ? await withWebLaneAuthorizationLocks(lockedChatIds, persistCutover)
        : await persistCutover();

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

      if (appRedirect) return reply.redirect(buildAppAuthRedirect(appRedirect, 'connected'));
      return reply.type('text/html').send(buildSuccessPage(payload.name, scopes.length));
    } catch (err) {
      log.error('Callback error: %s', err instanceof Error ? err.message : String(err));
      if (appRedirect) return reply.redirect(buildAppAuthRedirect(appRedirect, 'error'));
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

function safeAppRedirect(value: string | null): string | null {
  if (!value) return null;
  if (value === '/app' || value.startsWith('/app/')) return value;
  return null;
}

function buildAppAuthRedirect(path: string, result: 'connected' | 'denied' | 'error'): string {
  const url = new URL(path, config.web.baseUrl);
  url.searchParams.set('auth', result);
  return url.toString();
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

function reassignCharacterOwnership(db: Db, userId: number, characterId: number): void {
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
      db.prepare('UPDATE users SET active_character_id = NULL, active_character_version = active_character_version + 1, updated_at = datetime(\'now\') WHERE user_id = ? AND active_character_id = ?')
        .run(link.user_id, characterId);
    }
  }

  db.prepare('DELETE FROM eve_character_links WHERE character_id = ? AND COALESCE(user_id, 0) != ?')
    .run(characterId, userId);
  db.prepare('UPDATE eve_accounts SET user_id = ? WHERE character_id = ?').run(userId, characterId);
  // Ownership changed hands: drop the materialized private profile so rows
  // synced under the previous owner's consent are not inherited; the new
  // owner re-syncs on first use under their own scopes.
  deleteCharacterData(db, characterId);
}

function deleteCharacterProfileArtifacts(db: Db, characterId: number): void {
  const links = db.prepare(`
    SELECT chat_id, user_id
    FROM eve_character_links
    WHERE character_id = ?
  `).all(characterId) as Array<{ chat_id: number; user_id: number | null }>;
  const account = db.prepare('SELECT user_id FROM eve_accounts WHERE character_id = ?')
    .get(characterId) as { user_id: number | null } | undefined;

  for (const link of links) {
    const ctx = { userId: link.user_id ?? account?.user_id ?? 0, chatId: link.chat_id };
    rmSync(resolveUserProfilePath(ctx, characterId), { force: true });
  }
  const userIds = new Set<number>();
  if (account?.user_id) userIds.add(account.user_id);
  for (const link of links) {
    if (link.user_id) userIds.add(link.user_id);
  }
  for (const linkedUserId of userIds) {
    rmSync(resolveUserProfilePath({ userId: linkedUserId }, characterId), { force: true });
  }
}

type BrowserSsoOwnerPlan =
  | { kind: 'keep'; userId: number }
  | { kind: 'merge'; requestedUserId: number; existingUserId: number; chatId: number; orphanChatIds: number[] };

function planBrowserSsoOwner(
  db: Db,
  input: {
    requestedUserId: number;
    chatId: number | null;
    characterId: number;
    isBrowserFlow: boolean;
  },
): BrowserSsoOwnerPlan {
  if (!input.isBrowserFlow || input.chatId === null) {
    return { kind: 'keep', userId: input.requestedUserId };
  }
  const browserSession = db.prepare(`
    SELECT 1
    FROM web_sessions
    WHERE user_id = ? AND chat_id = ? AND expires_at > datetime('now')
  `).get(input.requestedUserId, input.chatId);
  if (!browserSession) throw new Error('Browser SSO session no longer exists');

  const existing = db.prepare(`
    SELECT COALESCE(
      (SELECT user_id FROM eve_accounts WHERE character_id = ? AND user_id IS NOT NULL),
      (SELECT user_id FROM eve_character_links WHERE character_id = ? AND user_id IS NOT NULL LIMIT 1)
    ) AS user_id
  `).get(input.characterId, input.characterId) as { user_id: number | null } | undefined;
  if (!existing || existing.user_id === null || existing.user_id === input.requestedUserId) {
    return { kind: 'keep', userId: input.requestedUserId };
  }

  // A browser identity may own several characters: linking a character owned
  // by someone else always merges the fresh guest into the existing owner.
  return {
    kind: 'merge',
    requestedUserId: input.requestedUserId,
    existingUserId: existing.user_id,
    chatId: input.chatId,
    orphanChatIds: listOrphanedWebLaneIds(db, existing.user_id, input.chatId),
  };
}

function applyBrowserSsoOwnerPlan(db: Db, plan: BrowserSsoOwnerPlan): number {
  if (plan.kind === 'keep') return plan.userId;
  // Adopt first: rows moved off orphaned lanes keep the surviving user_id, so
  // the idempotency-unique transfers below collide against the owner's
  // pre-existing rows and it is the fresh guest duplicates that are dropped.
  adoptOrphanedWebLanes(db, plan.existingUserId, plan.chatId);
  db.prepare('UPDATE web_sessions SET user_id = ? WHERE user_id = ? AND chat_id = ?')
    .run(plan.existingUserId, plan.requestedUserId, plan.chatId);
  db.prepare('UPDATE agent_threads SET user_id = ? WHERE user_id = ? AND chat_id = ?')
    .run(plan.existingUserId, plan.requestedUserId, plan.chatId);
  db.prepare('UPDATE OR IGNORE web_agent_requests SET user_id = ? WHERE user_id = ? AND chat_id = ?')
    .run(plan.existingUserId, plan.requestedUserId, plan.chatId);
  // Colliding guest duplicates go once terminal; in-flight rows are never
  // deleted — a live runner may still finish them.
  db.prepare(`
    DELETE FROM web_agent_requests
    WHERE user_id = ? AND chat_id = ? AND status NOT IN ('queued', 'running')
  `).run(plan.requestedUserId, plan.chatId);
  db.prepare('UPDATE web_admission_events SET user_id = ? WHERE user_id = ?')
    .run(plan.existingUserId, plan.requestedUserId);
  db.prepare('UPDATE intel_notes SET user_id = ? WHERE user_id = ?')
    .run(plan.existingUserId, plan.requestedUserId);
  db.prepare('UPDATE auth_requests SET user_id = ? WHERE user_id = ? AND chat_id = ?')
    .run(plan.existingUserId, plan.requestedUserId, plan.chatId);
  // User-scoped data the fresh guest may have accumulated before linking must
  // follow the surviving identity; nothing stays behind on the deleted user.
  db.prepare('UPDATE market_price_alerts SET user_id = ? WHERE user_id = ?')
    .run(plan.existingUserId, plan.requestedUserId);
  db.prepare('UPDATE market_alert_events SET user_id = ? WHERE user_id = ?')
    .run(plan.existingUserId, plan.requestedUserId);
  db.prepare('UPDATE usage_events SET user_id = ? WHERE user_id = ?')
    .run(plan.existingUserId, plan.requestedUserId);
  // Characters the guest linked before the merge follow the surviving
  // identity as well: a browser user may own several EVE characters.
  db.prepare('UPDATE eve_accounts SET user_id = ? WHERE user_id = ?')
    .run(plan.existingUserId, plan.requestedUserId);
  db.prepare('UPDATE eve_character_links SET user_id = ? WHERE user_id = ?')
    .run(plan.existingUserId, plan.requestedUserId);
  db.prepare(`
    UPDATE users
    SET active_character_id = (SELECT active_character_id FROM users WHERE user_id = ?),
        active_character_version = active_character_version + 1,
        updated_at = datetime('now')
    WHERE user_id = ?
      AND active_character_id IS NULL
      AND (SELECT active_character_id FROM users WHERE user_id = ?) IS NOT NULL
  `).run(plan.requestedUserId, plan.existingUserId, plan.requestedUserId);
  db.prepare('UPDATE OR IGNORE market_watchlist SET user_id = ? WHERE user_id = ?')
    .run(plan.existingUserId, plan.requestedUserId);
  db.prepare('DELETE FROM market_watchlist WHERE user_id = ?').run(plan.requestedUserId);
  db.prepare('UPDATE OR IGNORE heartbeat_config SET user_id = ? WHERE user_id = ?')
    .run(plan.existingUserId, plan.requestedUserId);
  db.prepare('DELETE FROM heartbeat_config WHERE user_id = ?').run(plan.requestedUserId);
  db.prepare(`
    INSERT INTO usage_daily (
      day, channel, model, user_id, events, input_tokens, output_tokens,
      cached_tokens, cache_write_tokens, reasoning_tokens, cost_micros, unknown_cost_events
    )
    SELECT day, channel, model, ?, events, input_tokens, output_tokens,
      cached_tokens, cache_write_tokens, reasoning_tokens, cost_micros, unknown_cost_events
    FROM usage_daily WHERE user_id = ?
    ON CONFLICT(day, channel, model, user_id) DO UPDATE SET
      events = events + excluded.events,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cached_tokens = cached_tokens + excluded.cached_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
      cost_micros = cost_micros + excluded.cost_micros,
      unknown_cost_events = unknown_cost_events + excluded.unknown_cost_events
  `).run(plan.existingUserId, plan.requestedUserId);
  db.prepare('DELETE FROM usage_daily WHERE user_id = ?').run(plan.requestedUserId);
  // In-flight requests pinned to the guest by an idempotency collision still
  // reference the guest row; the identity row goes once they finish.
  const requestsLeft = db.prepare(
    'SELECT 1 FROM web_agent_requests WHERE user_id = ? LIMIT 1',
  ).get(plan.requestedUserId);
  if (!requestsLeft) {
    db.prepare('DELETE FROM users WHERE user_id = ?').run(plan.requestedUserId);
  }
  return plan.existingUserId;
}

// Web lanes belong to individual browser sessions, but the user's history
// belongs to the user. When a returning user's previous sessions expired,
// their lanes are orphaned (no live session row); fold those lanes into the
// lane of the session that just linked the character so the old conversations
// resurface in the sidebar. Lanes with a live session (another device) keep
// their own view and are left untouched.
function listOrphanedWebLaneIds(db: Db, userId: number, currentChatId: number): number[] {
  const rows = db.prepare(`
    SELECT s.chat_id
    FROM telegram_sessions s
    WHERE s.username = 'web'
      AND s.chat_id <= ?
      AND s.chat_id != ?
      AND NOT EXISTS (
        SELECT 1 FROM web_sessions w
        WHERE w.chat_id = s.chat_id AND w.expires_at > datetime('now')
      )
      AND (
        EXISTS (SELECT 1 FROM agent_threads t WHERE t.chat_id = s.chat_id AND t.user_id = ?)
        OR EXISTS (SELECT 1 FROM eve_character_links l WHERE l.chat_id = s.chat_id AND l.user_id = ?)
      )
    ORDER BY s.chat_id ASC
  `).all(WEB_CHAT_ID_START, currentChatId, userId, userId) as Array<{ chat_id: number }>;
  return rows.map((row) => row.chat_id);
}

function adoptOrphanedWebLanes(db: Db, userId: number, currentChatId: number): void {
  for (const orphanChatId of listOrphanedWebLaneIds(db, userId, currentChatId)) {
    // Expired session rows only block the telegram_sessions FK; live sessions
    // cannot exist here by the selection above.
    db.prepare('DELETE FROM web_sessions WHERE chat_id = ?').run(orphanChatId);
    db.prepare('UPDATE agent_threads SET chat_id = ? WHERE chat_id = ?').run(currentChatId, orphanChatId);
    db.prepare('UPDATE OR IGNORE web_agent_requests SET chat_id = ? WHERE chat_id = ?')
      .run(currentChatId, orphanChatId);
    // In-flight rows are never dropped: a live runner may still finish them.
    // Rows left behind by an idempotency-key collision on the adopting lane go
    // only once they reached a terminal state.
    db.prepare(`
      DELETE FROM web_agent_requests
      WHERE chat_id = ? AND status NOT IN ('queued', 'running')
    `).run(orphanChatId);
    db.prepare('UPDATE OR IGNORE eve_character_links SET chat_id = ? WHERE chat_id = ?').run(currentChatId, orphanChatId);
    db.prepare('DELETE FROM eve_character_links WHERE chat_id = ?').run(orphanChatId);
    db.prepare('UPDATE OR IGNORE route_monitors SET chat_id = ? WHERE chat_id = ?').run(currentChatId, orphanChatId);
    db.prepare('DELETE FROM route_monitors WHERE chat_id = ?').run(orphanChatId);
    db.prepare('UPDATE OR IGNORE route_monitor_kill_dedup SET chat_id = ? WHERE chat_id = ?').run(currentChatId, orphanChatId);
    db.prepare('DELETE FROM route_monitor_kill_dedup WHERE chat_id = ?').run(orphanChatId);
    db.prepare('UPDATE OR IGNORE kill_watches SET chat_id = ? WHERE chat_id = ?').run(currentChatId, orphanChatId);
    db.prepare('DELETE FROM kill_watches WHERE chat_id = ?').run(orphanChatId);
    db.prepare('UPDATE OR IGNORE eve_kill_notification_dedup SET chat_id = ? WHERE chat_id = ?').run(currentChatId, orphanChatId);
    db.prepare('DELETE FROM eve_kill_notification_dedup WHERE chat_id = ?').run(orphanChatId);
    db.prepare('DELETE FROM auth_requests WHERE chat_id = ?').run(orphanChatId);
    // Keep the lane row while in-flight requests still reference it (an
    // idempotency collision pinned them here); the next adoption retries the
    // teardown once they finish.
    const requestsLeft = db.prepare(
      'SELECT 1 FROM web_agent_requests WHERE chat_id = ? LIMIT 1',
    ).get(orphanChatId);
    if (!requestsLeft) {
      db.prepare('DELETE FROM telegram_sessions WHERE chat_id = ?').run(orphanChatId);
    }
  }
}
