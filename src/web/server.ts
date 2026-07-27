import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { createLogger } from '../observability/logger.js';
import { registerAuthRoutes } from './auth-routes.js';
import { buildCanonicalLoopbackUrl } from './canonical-origin.js';
import { registerWebChatRoutes } from './chat-routes.js';
import { registerHealthRoute } from './health.js';
import { registerMarketAlertRoutes } from './market-alert-routes.js';
import { registerMarketAiSearchRoutes } from './market-ai-search-routes.js';
import { registerMarketRoutes } from './market-routes.js';
import { registerProfileRoutes } from './profile-routes.js';
import { registerSecurityHeaders } from './security.js';
import { registerSettingsRoutes } from './settings-routes.js';

export async function createServer(db: Db) {
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    trustProxy: config.web.trustedProxyCidrs.length > 0
      ? [...config.web.trustedProxyCidrs]
      : false,
  });
  registerWebErrorHandler(app);
  await app.register(fastifyCookie);
  registerSecurityHeaders(app, {
    baseUrl: config.web.baseUrl,
    turnstileEnabled: Boolean(config.web.turnstileSiteKey && config.web.turnstileSecretKey),
  });

  registerHealthRoute(app, { db });
  registerAuthRoutes(app, db);
  if (config.web.chatEnabled) {
    registerWebChatRoutes(app, db);
    registerMarketRoutes(app, db);
    registerMarketAiSearchRoutes(app, db);
    registerMarketAlertRoutes(app, db);
    registerSettingsRoutes(app, db);
    registerProfileRoutes(app, db);
    await registerWebApp(app);
  }

  return app;
}

const log = createLogger('web');

/**
 * Last-resort 500: Fastify's default handler serializes err.message, which
 * leaks SQLite codes/text and internal details to the browser. Framework 4xx
 * (bad JSON, unknown body shape) keeps its own safe message; anything else is
 * logged in full on the server and answered with a generic body.
 */
export function registerWebErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      void reply.status(statusCode).send({ error: error.message });
      return;
    }
    log.error(
      'Unhandled request error: %s %s — %s',
      request.method,
      request.url,
      error.stack ?? error.message,
    );
    void reply.status(500).send({ error: 'Внутренняя ошибка сервера.' });
  });
}

async function registerWebApp(app: FastifyInstance): Promise<void> {
  const distRoot = resolve(process.cwd(), 'web/dist');
  if (!existsSync(resolve(distRoot, 'index.html'))) return;

  await app.register(fastifyStatic, {
    root: distRoot,
    prefix: '/web-assets/',
    wildcard: false,
  });
  const html = await readFile(resolve(distRoot, 'index.html'), 'utf8');
  const sendApp = async (request: FastifyRequest, reply: FastifyReply) => {
    const canonicalUrl = buildCanonicalLoopbackUrl(
      config.web.baseUrl,
      request.url,
      request.protocol,
      request.headers.host,
    );
    if (canonicalUrl) return reply.redirect(canonicalUrl);
    return reply.type('text/html; charset=utf-8').send(html);
  };
  app.get('/', async (_request, reply) => reply.redirect('/app'));
  app.get('/app', sendApp);
  app.get('/app/*', sendApp);
}
