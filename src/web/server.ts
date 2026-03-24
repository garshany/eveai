import Fastify from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerHealthRoute } from './health.js';
import { registerApiRoutes } from './api-routes.js';
import { registerFrontendRoutes } from './frontend.js';
import { registerSecurityHeaders } from './security.js';

export async function createServer(db: Db) {
  const app = Fastify({ logger: false });
  registerSecurityHeaders(app, { baseUrl: config.web.baseUrl });

  registerHealthRoute(app, { db, openaiBaseUrl: config.openai.baseUrl });
  registerAuthRoutes(app, db);
  registerApiRoutes(app, db);
  registerFrontendRoutes(app, db);

  return app;
}
