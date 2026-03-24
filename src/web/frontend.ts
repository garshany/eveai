import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { createTelegramLoginNonce } from '../auth/telegram-login.js';
import { resolveRequestUser } from './middleware.js';

interface ClientManifestEntry {
  file: string;
  css?: string[];
}

interface ClientAssets {
  scriptPath: string;
  stylePaths: string[];
}

const CLIENT_DIST_DIR = resolve(process.cwd(), 'dist/client');
const CLIENT_MANIFEST_PATH = resolve(CLIENT_DIST_DIR, '.vite/manifest.json');
const CLIENT_ENTRY_KEY = 'client/src/main.tsx';

export function registerFrontendRoutes(app: FastifyInstance, db: Db): void {
  app.get('/client/*', async (req, reply) => {
    const assetPath = (req.params as { '*': string })['*'];
    const resolvedPath = resolve(CLIENT_DIST_DIR, assetPath);

    if (!resolvedPath.startsWith(CLIENT_DIST_DIR)) {
      return reply.code(403).send('Forbidden');
    }

    try {
      const contents = await readFile(resolvedPath);
      return reply
        .header('Cache-Control', 'public, max-age=300')
        .type(getContentType(resolvedPath))
        .send(contents);
    } catch {
      return reply.code(404).send('Not found');
    }
  });

  app.get('/', async (req, reply) => {
    const userId = resolveRequestUser(db, req);
    if (userId) {
      return reply.redirect('/app');
    }

    return reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(
        await buildFrontendHtml({
          page: 'landing',
          title: 'EVE Agent - AI агент для EVE Online',
          authUrl: buildTelegramAuthUrl(db),
        }),
      );
  });

  app.get('/app', async (req, reply) => {
    const userId = resolveRequestUser(db, req);
    if (!userId) {
      return reply.redirect('/');
    }

    return reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(
        await buildFrontendHtml({
          page: 'dashboard',
          title: 'EVE Agent - Dashboard',
          authUrl: `${config.web.baseUrl}/auth/telegram/callback`,
        }),
      );
  });
}

async function buildFrontendHtml(
  options: { page: 'landing' | 'dashboard'; title: string; authUrl: string },
): Promise<string> {
  const assets = await loadClientAssets();
  const botUsername = config.telegram.botUsername;
  const botLink = botUsername ? `https://t.me/${encodeURIComponent(botUsername)}` : '';

  const styles = assets.stylePaths
    .map((stylePath) => `<link rel="stylesheet" href="${escapeHtml(stylePath)}">`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%2305070e'/%3E%3Cpath d='M18 46V18h9l5 16 5-16h9v28h-6V28l-6 18h-5l-6-18v18z' fill='%23d9f7ff'/%3E%3C/svg%3E">
${styles}
<script type="module" src="${escapeHtml(assets.scriptPath)}" defer></script>
</head>
<body>
<div id="root" data-page="${escapeHtml(options.page)}" data-bot-username="${escapeHtml(botUsername)}" data-auth-url="${escapeHtml(options.authUrl)}" data-bot-link="${escapeHtml(botLink)}"></div>
</body>
</html>`;
}

function buildTelegramAuthUrl(db: Db): string {
  const nonce = createTelegramLoginNonce(db);
  const authUrl = new URL('/auth/telegram/callback', config.web.baseUrl);
  authUrl.searchParams.set('nonce', nonce);
  return authUrl.toString();
}

async function loadClientAssets(): Promise<ClientAssets> {
  const manifestRaw = await readFile(CLIENT_MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(manifestRaw) as Record<string, ClientManifestEntry>;
  const entry = manifest[CLIENT_ENTRY_KEY];

  if (!entry) {
    throw new Error(`Client manifest missing ${CLIENT_ENTRY_KEY}`);
  }

  return {
    scriptPath: normalizeAssetPath(entry.file),
    stylePaths: (entry.css ?? []).map(normalizeAssetPath),
  };
}

function normalizeAssetPath(assetPath: string): string {
  return join('/client', assetPath).replaceAll('\\', '/');
}

function getContentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.woff2':
      return 'font/woff2';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
