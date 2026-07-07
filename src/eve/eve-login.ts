/**
 * EVE SSO login-link helpers shared by the bots and the web callback.
 *
 * The full SSO authorize URL is ~2.1KB (58 scopes), which exceeds Discord's
 * 2000-char message limit and its 512-char link-button limit. So the bots send
 * a short link to the app's own /auth/eve/login endpoint, which 302-redirects
 * the browser to EVE. This module has no chat/web imports to stay cycle-free.
 */
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { ALL_REQUESTED_SCOPES } from './scopes.js';
import { createAuthRequestToken } from '../auth/auth-request.js';

/** Build the full EVE SSO authorize URL for a given (raw) state token. */
export function buildEveAuthorizeUrl(state: string): string {
  const url = new URL('https://login.eveonline.com/v2/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.eve.callbackUrl);
  url.searchParams.set('client_id', config.eve.clientId);
  url.searchParams.set('scope', ALL_REQUESTED_SCOPES.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Create a one-time login request bound to (user, chat) and return a short link
 * to the app's redirect endpoint that a chat client can safely send.
 */
export function createEveLoginLink(db: Db, userId: number, chatId: number): string {
  const state = createAuthRequestToken(db, 'eve_sso', userId, { chatId, ttlSeconds: 600 });
  const base = config.web.baseUrl.replace(/\/+$/, '');
  return `${base}/auth/eve/login?state=${encodeURIComponent(state)}`;
}
