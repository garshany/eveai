import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { resolveRequestUser } from './middleware.js';
import { getUserDisplayName, getUserTelegramChatId, type UserContext } from '../auth/user-resolver.js';
import { listLinkedCharacters, setActiveCharacter, unlinkCharacter } from '../eve/sso.js';

export function registerApiRoutes(app: FastifyInstance, db: Db): void {
  // GET /api/me
  app.get('/api/me', async (req, reply) => {
    const userId = resolveRequestUser(db, req);
    if (!userId) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const displayName = getUserDisplayName(db, userId);
    const chatId = getUserTelegramChatId(db, userId) ?? undefined;
    const ctx: UserContext = { userId, chatId };

    const characters = listLinkedCharacters(db, ctx).map((c) => ({
      characterId: c.characterId,
      characterName: c.characterName,
      isActive: c.isActive,
      portrait: `https://images.evetech.net/characters/${c.characterId}/portrait?size=128`,
    }));

    // Get telegram username
    const tgRow = db.prepare(
      'SELECT username FROM telegram_accounts WHERE user_id = ?',
    ).get(userId) as { username: string } | undefined;

    return reply.send({
      userId,
      displayName,
      telegramUsername: tgRow?.username || null,
      characters,
    });
  });

  // POST /api/characters/:id/activate
  app.post<{ Params: { id: string } }>('/api/characters/:id/activate', async (req, reply) => {
    const userId = resolveRequestUser(db, req);
    if (!userId) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const characterId = Number(req.params.id);
    if (!Number.isFinite(characterId) || characterId <= 0) {
      return reply.status(400).send({ error: 'Invalid character ID' });
    }

    const chatId = getUserTelegramChatId(db, userId) ?? undefined;
    const ctx: UserContext = { userId, chatId };
    const ok = setActiveCharacter(db, ctx, characterId);

    if (!ok) {
      return reply.status(404).send({ error: 'Character not linked to this user' });
    }

    return reply.send({ ok: true });
  });

  // POST /api/characters/:id/unlink
  app.post<{ Params: { id: string } }>('/api/characters/:id/unlink', async (req, reply) => {
    const userId = resolveRequestUser(db, req);
    if (!userId) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const characterId = Number(req.params.id);
    if (!Number.isFinite(characterId) || characterId <= 0) {
      return reply.status(400).send({ error: 'Invalid character ID' });
    }

    const chatId = getUserTelegramChatId(db, userId) ?? undefined;
    const ctx: UserContext = { userId, chatId };
    const ok = await unlinkCharacter(db, ctx, characterId);

    if (!ok) {
      return reply.status(404).send({ error: 'Character not linked to this user' });
    }

    return reply.send({ ok: true });
  });
}
