import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { registerAuthRoutes } from './auth-routes.js';
import { buildCanonicalLoopbackUrl } from './canonical-origin.js';
import { registerWebChatRoutes } from './chat-routes.js';
import { registerHealthRoute } from './health.js';
import { registerSecurityHeaders } from './security.js';

export async function createServer(db: Db) {
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    trustProxy: config.web.trustedProxyCidrs.length > 0
      ? [...config.web.trustedProxyCidrs]
      : false,
  });
  await app.register(fastifyCookie);
  registerSecurityHeaders(app, {
    baseUrl: config.web.baseUrl,
    turnstileEnabled: Boolean(config.web.turnstileSiteKey && config.web.turnstileSecretKey),
  });

  registerHealthRoute(app, { db });
  registerAuthRoutes(app, db);
  if (config.web.chatEnabled) {
    registerWebChatRoutes(app, db);
    await registerWebApp(app);
  }

  return app;
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
