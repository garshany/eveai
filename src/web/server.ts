import Fastify from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db/sqlite.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerHealthRoute } from './health.js';
import { registerSecurityHeaders } from './security.js';

export async function createServer(db: Db) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  registerSecurityHeaders(app, { baseUrl: config.web.baseUrl });

  registerHealthRoute(app, { db });
  registerAuthRoutes(app, db);

  return app;
}
