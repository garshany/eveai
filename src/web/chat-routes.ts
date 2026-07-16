import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { createAuthRequestToken } from '../auth/auth-request.js';
import {
  MAX_INPUT_LENGTH,
  resolveThreadForChat,
} from '../chat/shared.js';
import {
  getLinkedCharacter,
  listLinkedCharacters,
  setActiveCharacter,
} from '../eve/sso.js';
import { isEveSsoConfigured } from '../eve/eve-login.js';
import { fetchWithTimeout } from '../eve/http.js';
import {
  discardRouteMonitor,
  getRouteMonitorRuntimeStatus,
  stopRouteMonitor,
} from '../eve-board/monitor.js';
import { getEveKillFeedRuntimeStatus } from '../eve-kill/feed-poll.js';
import { loadWebPilotProfile } from './pilot-profile.js';
import {
  clearWebSessionCookies,
  cleanExpiredWebSessions,
  createWebSession,
  evaluateWebSessionCreationAllowance,
  readWebSession,
  revokeWebSession,
  reuseOrRotateWebCsrf,
  setWebSessionCookies,
  verifyWebMutation,
  verifyWebSessionCreation,
  buildWebClientIpKey,
  type WebSession,
} from './web-session.js';
import { WebAgentRequestCoordinator } from './agent-requests.js';
import { isTurnstileEnabled, verifyTurnstileToken } from './turnstile.js';

type ConversationRow = {
  thread_id: string;
  character_id: number | null;
  updated_at: string;
  title: string | null;
};

type ChatBody = {
  message?: unknown;
  threadId?: unknown;
  idempotencyKey?: unknown;
};
type EveLoginBody = { language?: unknown };
type SessionBody = { turnstileToken?: unknown };

type ThreadParams = { threadId: string };
type CharacterParams = { characterId: string };
type RequestParams = { requestId: string };
type ActiveRequestQuery = { threadId?: string };
const MAX_WEB_CONVERSATIONS = 40;

export function registerWebChatRoutes(app: FastifyInstance, db: Db): void {
  const agentRequests = new WebAgentRequestCoordinator(db);
  agentRequests.start();
  const sessionCleanupTimer = setInterval(() => {
    void cleanExpiredWebSessions(db);
  }, 60_000);
  sessionCleanupTimer.unref?.();
  app.addHook('onClose', async () => {
    clearInterval(sessionCleanupTimer);
    await agentRequests.close();
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/web/')) {
      void cleanExpiredWebSessions(db);
      reply.header('Cache-Control', 'no-store');
    }
  });

  app.get('/api/web/session', async (request, reply) => {
    const session = readWebSession(db, request);
    if (!session) return {
      session: null,
      ssoConfigured: isEveSsoConfigured(),
      turnstileSiteKey: isTurnstileEnabled() ? config.web.turnstileSiteKey : null,
    };
    const csrfToken = reuseOrRotateWebCsrf(db, request, session);
    setWebSessionCookies(reply, { csrfToken });
    return buildSessionPayload(db, session, csrfToken);
  });

  app.post<{ Body: SessionBody }>('/api/web/session', async (request, reply) => {
    if (!verifyWebSessionCreation(request)) {
      return reply.status(403).send({ error: 'Запрос с другого источника отклонён.' });
    }
    const existing = readWebSession(db, request);
    if (existing) {
      const csrfToken = reuseOrRotateWebCsrf(db, request, existing);
      setWebSessionCookies(reply, { csrfToken });
      return buildSessionPayload(db, existing, csrfToken);
    }
    const turnstile = await verifyTurnstileToken(
      request.body?.turnstileToken,
      request.ip,
      'session',
    );
    if (!turnstile.ok) {
      return reply.status(turnstile.retryable ? 503 : 403).send({
        error: turnstile.retryable
          ? 'Проверка защиты временно недоступна. Попробуйте ещё раз.'
          : 'Подтвердите, что вы не робот.',
      });
    }
    const ipKey = buildWebClientIpKey(request.ip);
    const allowance = evaluateWebSessionCreationAllowance(db, ipKey);
    if (!allowance.ok) {
      reply.header('Retry-After', String(allowance.retryAfterSeconds));
      return reply.status(429).send({ error: 'Слишком много новых сессий. Попробуйте позже.' });
    }
    const created = createWebSession(db, ipKey);
    setWebSessionCookies(reply, created);
    return buildSessionPayload(db, created, created.csrfToken);
  });

  app.delete('/api/web/session', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    await agentRequests.cancelLaneAndWait({ userId: session.userId, chatId: session.chatId });
    await revokeWebSession(db, request);
    clearWebSessionCookies(reply);
    return reply.status(204).send();
  });

  app.post<{ Body: EveLoginBody }>('/api/web/eve/login', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    if (!isEveSsoConfigured()) {
      return reply.status(503).send({ error: 'EVE SSO пока не настроен оператором.' });
    }
    const state = createAuthRequestToken(db, 'eve_sso', session.userId, {
      chatId: session.chatId,
      redirectUrl: '/app',
      ttlSeconds: 600,
    });
    const base = config.web.baseUrl.replace(/\/+$/, '');
    const language = request.body?.language === 'en' ? 'en' : 'ru';
    return { url: `${base}/auth/eve/login?state=${encodeURIComponent(state)}&language=${language}` };
  });

  app.get('/api/web/conversations', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    return { conversations: listConversations(db, session) };
  });

  app.post('/api/web/conversations', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const reusable = findEmptyConversation(db, session);
    if (reusable) return reply.status(200).send({ threadId: reusable });
    const count = db.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_threads
      WHERE chat_id = ? AND user_id = ?
    `).get(session.chatId, session.userId) as { count: number };
    if (count.count >= MAX_WEB_CONVERSATIONS) {
      return reply.status(409).send({
        error: `Достигнут лимит в ${MAX_WEB_CONVERSATIONS} диалогов. Удалите ненужный диалог.`,
      });
    }
    const threadId = createConversation(db, session);
    return reply.status(201).send({ threadId });
  });

  app.get<{ Params: ThreadParams }>('/api/web/conversations/:threadId/messages', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const thread = ownedThread(db, session, request.params.threadId);
    if (!thread) return reply.status(404).send({ error: 'Диалог не найден.' });
    const messages = db.prepare(`
      SELECT id, role, content, created_at
      FROM (
        SELECT id, role, content, created_at
        FROM messages
        WHERE thread_id = ? AND role IN ('user', 'assistant')
        ORDER BY id DESC
        LIMIT 200
      ) recent
      ORDER BY id ASC
    `).all(thread.thread_id) as Array<{
      id: number;
      role: 'user' | 'assistant';
      content: string;
      created_at: string;
    }>;
    return { messages };
  });

  app.delete<{ Params: ThreadParams }>('/api/web/conversations/:threadId', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const thread = ownedThread(db, session, request.params.threadId);
    if (!thread) return reply.status(404).send({ error: 'Диалог не найден.' });
    if (agentRequests.readActive(
      { userId: session.userId, chatId: session.chatId },
      thread.thread_id,
    )) {
      return reply.status(409).send({ error: 'Сначала дождитесь завершения или отмените активный запрос.' });
    }
    const remove = db.transaction(() => {
      db.prepare('DELETE FROM thread_summaries WHERE thread_id = ?').run(thread.thread_id);
      db.prepare('DELETE FROM messages WHERE thread_id = ?').run(thread.thread_id);
      db.prepare('DELETE FROM thread_artifacts WHERE thread_id = ?').run(thread.thread_id);
      db.prepare('DELETE FROM agent_threads WHERE thread_id = ?').run(thread.thread_id);
    });
    remove();
    return reply.status(204).send();
  });

  app.get('/api/web/characters', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    return { characters: listLinkedCharacters(db, sessionContext(session)) };
  });

  app.post<{ Params: CharacterParams }>('/api/web/characters/:characterId/activate', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const characterId = parsePositiveInteger(request.params.characterId);
    if (!characterId || !setActiveCharacter(db, sessionContext(session), characterId)) {
      return reply.status(404).send({ error: 'Персонаж не найден.' });
    }
    const monitor = getRouteMonitorRuntimeStatus(db, session.chatId).monitor;
    if (monitor && monitor.characterId !== characterId) {
      discardRouteMonitor(session.chatId, db);
    }
    return buildSessionPayload(db, session, request.headers['x-csrf-token'] as string);
  });

  app.get('/api/web/profile', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const startedAt = Date.now();
    try {
      let result = await loadWebPilotProfile(db, sessionContext(session));
      if (result.stale) result = await loadWebPilotProfile(db, sessionContext(session));
      console.log('[web-profile] DONE duration_ms=%d status=%s', Date.now() - startedAt, result.stale ? 'stale' : 'ok');
      if (result.stale) return reply.status(409).send({ error: 'Активный персонаж изменился. Повторите запрос.' });
      return { profile: result.profile };
    } catch (error) {
      console.error('[web-profile] FAILED duration_ms=%d error=%s', Date.now() - startedAt, error instanceof Error ? error.message : 'unknown');
      return reply.status(502).send({ error: 'Не удалось загрузить профиль EVE. Попробуйте ещё раз.' });
    }
  });

  app.get('/api/web/profile/portrait', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const character = getLinkedCharacter(db, sessionContext(session));
    if (!character) return reply.status(404).send({ error: 'Персонаж не подключён.' });
    try {
      const response = await fetchWithTimeout(
        `https://images.evetech.net/characters/${character.characterId}/portrait?tenant=tranquility&size=512`,
        { headers: { accept: 'image/avif,image/webp,image/png,image/jpeg' } },
        config.esi.requestTimeoutMs,
      );
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !contentType.startsWith('image/')) {
        return reply.status(502).send({ error: 'Портрет EVE временно недоступен.' });
      }
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength > 5_000_000) return reply.status(502).send({ error: 'Портрет EVE слишком большой.' });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 5_000_000) return reply.status(502).send({ error: 'Портрет EVE слишком большой.' });
      return reply
        .header('Cache-Control', 'private, max-age=300')
        .type(contentType)
        .send(bytes);
    } catch {
      return reply.status(502).send({ error: 'Портрет EVE временно недоступен.' });
    }
  });

  app.get('/api/web/scan', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    return buildWebScanPayload(db, session);
  });

  app.post('/api/web/scan/stop', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const status = getRouteMonitorRuntimeStatus(db, session.chatId);
    if (status.active) stopRouteMonitor(session.chatId, 'manual');
    else if (status.monitor) discardRouteMonitor(session.chatId, db);
    return reply.status(204).send();
  });

  app.get<{ Params: RequestParams }>('/api/web/chat/requests/:requestId', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const result = agentRequests.readOwned(
      { userId: session.userId, chatId: session.chatId },
      request.params.requestId,
    );
    if (!result) return reply.status(404).send({ error: 'Запрос не найден.' });
    return { request: result };
  });

  app.get<{ Params: RequestParams }>('/api/web/chat/requests/:requestId/events', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const owner = { userId: session.userId, chatId: session.chatId };
    const initial = agentRequests.readOwned(owner, request.params.requestId);
    if (!initial) return reply.status(404).send({ error: 'Запрос не найден.' });

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const rawLastEventId = request.headers['last-event-id'];
    let lastSequence = typeof rawLastEventId === 'string' && /^\d+$/.test(rawLastEventId)
      ? Number(rawLastEventId)
      : -1;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(snapshotTimer);
      clearInterval(heartbeatTimer);
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    const sendSnapshot = () => {
      const snapshot = agentRequests.readOwned(owner, request.params.requestId);
      if (!snapshot) return close();
      if (snapshot.progressSequence !== lastSequence || lastSequence < 0) {
        lastSequence = snapshot.progressSequence;
        reply.raw.write(`id: ${lastSequence}\nevent: request\ndata: ${JSON.stringify({ request: snapshot })}\n\n`);
      }
      if (snapshot.status !== 'queued' && snapshot.status !== 'running') close();
    };
    const snapshotTimer = setInterval(sendSnapshot, 1_000);
    const heartbeatTimer = setInterval(() => {
      if (!closed) reply.raw.write(': heartbeat\n\n');
    }, 15_000);
    snapshotTimer.unref?.();
    heartbeatTimer.unref?.();
    request.raw.once('close', close);
    sendSnapshot();
    return reply;
  });

  app.get<{ Querystring: ActiveRequestQuery }>('/api/web/chat/requests/active', async (request, reply) => {
    const session = requireSession(db, request, reply);
    if (!session) return;
    const threadId = typeof request.query.threadId === 'string' && isThreadId(request.query.threadId)
      ? request.query.threadId
      : undefined;
    return {
      request: agentRequests.readActive(
        { userId: session.userId, chatId: session.chatId },
        threadId,
      ),
    };
  });

  app.delete<{ Params: RequestParams }>('/api/web/chat/requests/:requestId', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const result = agentRequests.cancel(
      { userId: session.userId, chatId: session.chatId },
      request.params.requestId,
    );
    if (!result) return reply.status(404).send({ error: 'Запрос не найден.' });
    return { request: result };
  });

  app.post<{ Body: ChatBody }>('/api/web/chat', async (request, reply) => {
    const session = requireMutationSession(db, request, reply);
    if (!session) return;
    const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';
    const requestedThreadId = typeof request.body?.threadId === 'string' ? request.body.threadId : null;
    if (!message) return reply.status(400).send({ error: 'Введите сообщение.' });
    if (message.length > MAX_INPUT_LENGTH) {
      return reply.status(413).send({ error: `Максимальная длина сообщения: ${MAX_INPUT_LENGTH} символов.` });
    }

    const ctx = sessionContext(session);
    const threadId = requestedThreadId
      ? ownedThreadForActiveCharacter(db, session, requestedThreadId)?.thread_id
      : resolveThreadForChat(db, session.chatId, ctx);
    if (!threadId) return reply.status(404).send({ error: 'Диалог не найден для активного персонажа.' });

    const idempotencyKey = typeof request.body?.idempotencyKey === 'string'
      && /^[A-Za-z0-9_-]{16,96}$/.test(request.body.idempotencyKey)
      ? request.body.idempotencyKey
      : randomUUID();
    const identity = db.prepare(`
      SELECT active_character_id, active_character_version FROM users WHERE user_id = ?
    `).get(session.userId) as {
      active_character_id: number | null;
      active_character_version: number;
    };
    const accepted = agentRequests.enqueue({
      userId: session.userId,
      chatId: session.chatId,
      threadId,
      characterId: identity.active_character_id,
      characterVersion: identity.active_character_version,
      message,
      idempotencyKey,
      ipKey: buildWebClientIpKey(request.ip),
    });
    if (!accepted.ok) {
      if (accepted.retryAfterSeconds > 0) {
        reply.header('Retry-After', String(accepted.retryAfterSeconds));
      }
      return reply.status(accepted.statusCode).send({ error: accepted.error });
    }
    const requestId = accepted.request.requestId;
    return reply.status(202).send({
      request: accepted.request,
      existing: accepted.existing,
      pollUrl: `/api/web/chat/requests/${encodeURIComponent(requestId)}`,
      cancelUrl: `/api/web/chat/requests/${encodeURIComponent(requestId)}`,
      eventsUrl: `/api/web/chat/requests/${encodeURIComponent(requestId)}/events`,
    });
  });
}

function requireSession(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
): WebSession | null {
  const session = readWebSession(db, request);
  if (session) return session;
  void reply.status(401).send({ error: 'Сессия истекла. Обновите страницу.' });
  return null;
}

function requireMutationSession(
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

function buildSessionPayload(db: Db, session: WebSession, csrfToken: string) {
  const user = db.prepare('SELECT display_name FROM users WHERE user_id = ?').get(session.userId) as {
    display_name: string;
  } | undefined;
  const ctx = sessionContext(session);
  const character = getLinkedCharacter(db, ctx);
  const characters = listLinkedCharacters(db, ctx).map((entry) => ({
    id: entry.characterId,
    name: entry.characterName,
    isActive: entry.isActive,
  }));
  return {
    session: {
      displayName: user?.display_name ?? 'Web capsuleer',
      csrfToken,
      character: character ? {
        id: character.characterId,
        name: character.characterName,
      } : null,
      characters,
    },
    ssoConfigured: isEveSsoConfigured(),
    turnstileSiteKey: isTurnstileEnabled() ? config.web.turnstileSiteKey : null,
  };
}

function sessionContext(session: WebSession) {
  return { userId: session.userId, chatId: session.chatId, notificationCapability: 'web' as const };
}

function buildWebScanPayload(db: Db, session: WebSession) {
  const runtime = getRouteMonitorRuntimeStatus(db, session.chatId);
  const feed = getEveKillFeedRuntimeStatus();
  const monitor = runtime.monitor;
  if (!monitor) {
    return {
      source: { transport: 'rest_poll' as const, ...feed },
      monitor: null,
    };
  }
  const names = new Map<number, string>();
  const rows = db.prepare(`
    SELECT system_id, name FROM sde_systems
    WHERE system_id IN (${monitor.routeSystems.map(() => '?').join(',')})
  `).all(...monitor.routeSystems) as Array<{ system_id: number; name: string }>;
  for (const row of rows) names.set(row.system_id, row.name);
  const currentIndex = monitor.routeSystems.indexOf(monitor.currentSystemId);
  return {
    source: { transport: 'rest_poll' as const, ...feed },
    monitor: {
      active: runtime.active,
      baselineReady: runtime.baselineReady,
      threatLevel: runtime.threatLevel,
      locationFailures: runtime.locationFailures,
      characterId: monitor.characterId,
      characterMatchesActive: getLinkedCharacter(db, sessionContext(session))?.characterId === monitor.characterId,
      origin: { id: monitor.originId, name: names.get(monitor.originId) ?? `System ${monitor.originId}` },
      destination: { id: monitor.destinationId, name: names.get(monitor.destinationId) ?? `System ${monitor.destinationId}` },
      current: { id: monitor.currentSystemId, name: names.get(monitor.currentSystemId) ?? `System ${monitor.currentSystemId}` },
      routeSystems: monitor.routeSystems.map((id) => ({ id, name: names.get(id) ?? `System ${id}` })),
      progress: {
        completed: monitor.stats.jumpsCompleted,
        total: Math.max(0, monitor.routeSystems.length - 1),
        remaining: currentIndex < 0 ? null : Math.max(0, monitor.routeSystems.length - 1 - currentIndex),
      },
      ship: { typeId: monitor.shipTypeId, name: monitor.shipName, ehp: monitor.shipEhp },
      startedAt: monitor.startedAt,
      lastLocationCheck: monitor.lastLocationCheck,
      lastOnlineCheck: monitor.lastOnlineCheck,
      killsSeen: monitor.stats.killsSeen,
      dangerEvents: monitor.stats.dangerEvents.slice(-20),
    },
  };
}

function listConversations(db: Db, session: WebSession) {
  const characterId = getLinkedCharacter(db, sessionContext(session))?.characterId ?? null;
  const rows = db.prepare(`
    SELECT
      t.thread_id,
      t.character_id,
      COALESCE(MAX(m.created_at), t.updated_at) AS updated_at,
      (
        SELECT substr(content, 1, 72)
        FROM messages first_message
        WHERE first_message.thread_id = t.thread_id AND first_message.role = 'user'
        ORDER BY first_message.id ASC
        LIMIT 1
      ) AS title
    FROM agent_threads t
    LEFT JOIN messages m ON m.thread_id = t.thread_id
    WHERE t.chat_id = ?
      AND t.user_id = ?
      AND ((t.character_id IS NULL AND ? IS NULL) OR t.character_id = ?)
    GROUP BY t.thread_id
    ORDER BY updated_at DESC
    LIMIT 40
  `).all(session.chatId, session.userId, characterId, characterId) as ConversationRow[];
  return rows.map((row) => ({
    id: row.thread_id,
    characterId: row.character_id,
    title: row.title?.trim() || 'Новый диалог',
    updatedAt: row.updated_at,
  }));
}

function createConversation(db: Db, session: WebSession): string {
  const ctx = sessionContext(session);
  const character = getLinkedCharacter(db, ctx);
  const threadId = randomUUID();
  db.prepare(`
    INSERT INTO agent_threads (thread_id, chat_id, character_id, user_id)
    VALUES (?, ?, ?, ?)
  `).run(threadId, session.chatId, character?.characterId ?? null, session.userId);
  return threadId;
}

function findEmptyConversation(db: Db, session: WebSession): string | null {
  const characterId = getLinkedCharacter(db, sessionContext(session))?.characterId ?? null;
  const row = db.prepare(`
    SELECT t.thread_id
    FROM agent_threads t
    WHERE t.chat_id = ?
      AND t.user_id = ?
      AND ((t.character_id IS NULL AND ? IS NULL) OR t.character_id = ?)
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.thread_id)
    ORDER BY t.created_at DESC, t.rowid DESC
    LIMIT 1
  `).get(session.chatId, session.userId, characterId, characterId) as { thread_id: string } | undefined;
  return row?.thread_id ?? null;
}

function ownedThread(db: Db, session: WebSession, threadId: string) {
  if (!isThreadId(threadId)) return null;
  return db.prepare(`
    SELECT thread_id, character_id
    FROM agent_threads
    WHERE thread_id = ? AND chat_id = ? AND user_id = ?
  `).get(threadId, session.chatId, session.userId) as {
    thread_id: string;
    character_id: number | null;
  } | undefined ?? null;
}

function ownedThreadForActiveCharacter(db: Db, session: WebSession, threadId: string) {
  const thread = ownedThread(db, session, threadId);
  if (!thread) return null;
  const active = getLinkedCharacter(db, sessionContext(session));
  if ((active?.characterId ?? null) !== thread.character_id) return null;
  return thread;
}

function isThreadId(value: string): boolean {
  return value.length <= 64 && /^[a-f0-9-]+$/i.test(value);
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
