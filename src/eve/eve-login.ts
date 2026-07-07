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

const PLACEHOLDER_CREDS = new Set([
  '', 'smoke', 'placeholder', 'test', 'changeme',
  'your_client_id', 'your_client_secret', 'your_secret_key', 'your_secret',
]);

/**
 * True when a credential value is an obvious placeholder rather than a real EVE
 * app credential. Covers the exact strings above, any `your_…`/`your-…` guide
 * placeholder, and punctuation-only values like the README's `...`.
 */
function isPlaceholderCred(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (PLACEHOLDER_CREDS.has(v)) return true;
  if (v.startsWith('your_') || v.startsWith('your-') || v.startsWith('your ')) return true;
  if (/^[.\-_*]+$/.test(v)) return true; // '...', '---', '***', etc.
  return false;
}

/** True when real EVE app credentials are configured (not the .env placeholders). */
export function isEveSsoConfigured(): boolean {
  return !isPlaceholderCred(config.eve.clientId) && !isPlaceholderCred(config.eve.clientSecret);
}

/**
 * A short, chat/terminal-friendly setup guide shown when a user tries to link a
 * character but EVE SSO isn't configured. URLs auto-link in Telegram/Discord.
 */
export function buildEveSsoSetupGuide(): string {
  return [
    'EVE SSO пока не настроен — привязка персонажа недоступна.',
    '',
    'Как включить (≈5 минут):',
    '1. Создай приложение: https://developers.eveonline.com/applications/create',
    '2. Connection Type: «Authentication & API Access», выбери нужные scopes (или все).',
    `3. Callback URL укажи ровно: ${config.eve.callbackUrl}`,
    '4. Скопируй Client ID и Secret Key в .env (EVE_CLIENT_ID / EVE_CLIENT_SECRET) и перезапусти.',
    '',
    'Публичные данные (SDE, рынок, маршруты, killboards, OSINT) работают и без этого.',
  ].join('\n');
}

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
