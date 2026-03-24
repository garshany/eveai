import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { resolveUserFromWebSession } from '../auth/user-resolver.js';
import { SESSION_COOKIE_NAME } from '../auth/session.js';

export function extractSessionCookie(req: FastifyRequest): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;

  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      return trimmed.slice(SESSION_COOKIE_NAME.length + 1);
    }
  }
  return null;
}

export function resolveRequestUser(db: Db, req: FastifyRequest): number | null {
  const sessionId = extractSessionCookie(req);
  if (!sessionId) return null;
  return resolveUserFromWebSession(db, sessionId);
}

export function requireAuth(
  db: Db,
  handler: (req: FastifyRequest, reply: FastifyReply, userId: number) => Promise<void>,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = resolveRequestUser(db, req);
    if (!userId) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    return handler(req, reply, userId);
  };
}
