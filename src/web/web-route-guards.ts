import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/sqlite.js';
import {
  readWebSession,
  verifyWebMutation,
  type WebSession,
} from './web-session.js';

/**
 * Shared browser-session guards for /api/web/* route modules (chat, market).
 * Moved out of chat-routes.ts unchanged: reads get a 401 when the session
 * cookie is missing or expired, mutations additionally get a 403 when the
 * origin/CSRF verification fails.
 */
export function requireSession(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
): WebSession | null {
  const session = readWebSession(db, request);
  if (session) return session;
  void reply.status(401).send({ error: 'Сессия истекла. Обновите страницу.' });
  return null;
}

export function requireMutationSession(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
): WebSession | null {
  const session = requireSession(db, request, reply);
  if (!session) return null;
  if (verifyWebMutation(request, session)) return session;
  void reply.status(403).send({ error: 'Проверка безопасности запроса не пройдена.' });
  return null;
}
