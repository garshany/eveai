import Fastify from 'fastify';
import type { Db } from '../db/sqlite.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerHealthRoute } from './health.js';

export async function createServer(db: Db) {
  const app = Fastify({ logger: false });

  registerHealthRoute(app);
  registerAuthRoutes(app, db);

  return app;
}
