/**
 * Platform-neutral chat pipeline shared by the Telegram and Discord bots:
 * chat-session rows, thread resolution, in-flight request tracking, rate
 * limiting, agent invocation, and user-facing error normalization.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { config } from '../config.js';
import { handleAgentMessage } from '../agent/executor.js';
import { finalizeThreadMessage } from '../agent/finalizer.js';
import { getLinkedCharacter } from '../eve/sso.js';
import { readUserProfile, refreshUserProfile } from '../eve/user-profile.js';
import { stopRouteMonitor } from '../eve-board/monitor.js';
import type { UserContext } from '../auth/user-resolver.js';

export const MAX_INPUT_LENGTH = 2000;
const DUPLICATE_REQUEST_WINDOW_MS = 30_000;
const DEFAULT_REQUEST_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 6;
const DEFAULT_MAX_ACTIVE_REQUESTS = 24;

// ---------------------------------------------------------------------------
// Chat session rows (telegram_sessions doubles as the generic chat registry;
// Discord lanes use negative chat keys)
// ---------------------------------------------------------------------------

export function ensureChatSessionRow(db: Db, chatId: number, username: string): void {
  db.prepare(
    `INSERT INTO telegram_sessions (chat_id, username, last_seen_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, last_seen_at = datetime('now')`,
  ).run(chatId, username);
}

// EVE SSO login link lives in eve/eve-login.ts (shared with the web callback).
export { createEveLoginLink } from '../eve/eve-login.js';

// ---------------------------------------------------------------------------
// Thread resolution
// ---------------------------------------------------------------------------

export function resolveThreadForChat(db: Db, chatId: number, ctx: UserContext): string {
  const activeCharacter = getLinkedCharacter(db, ctx);
  const activeCharacterId = activeCharacter?.characterId ?? null;

  let thread: { thread_id: string } | undefined;
  if (activeCharacterId) {
    thread = db.prepare(
      'SELECT thread_id FROM agent_threads WHERE chat_id = ? AND character_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(chatId, activeCharacterId) as { thread_id: string } | undefined;
  } else {
    thread = db.prepare(
      'SELECT thread_id FROM agent_threads WHERE chat_id = ? AND character_id IS NULL ORDER BY created_at DESC LIMIT 1',
    ).get(chatId) as { thread_id: string } | undefined;
  }

  if (thread) return thread.thread_id;

  const threadId = randomUUID();
  db.prepare('INSERT INTO agent_threads (thread_id, chat_id, character_id, user_id) VALUES (?, ?, ?, ?)').run(
    threadId, chatId, activeCharacterId, ctx.userId,
  );
  return threadId;
}

export function clearChatConversation(db: Db, chatId: number): number {
  const threads = db.prepare('SELECT thread_id FROM agent_threads WHERE chat_id = ?').all(chatId) as Array<{ thread_id: string }>;
  db.prepare('DELETE FROM thread_summaries WHERE thread_id IN (SELECT thread_id FROM agent_threads WHERE chat_id = ?)').run(chatId);
  db.prepare('DELETE FROM messages WHERE thread_id IN (SELECT thread_id FROM agent_threads WHERE chat_id = ?)').run(chatId);
  db.prepare('DELETE FROM agent_threads WHERE chat_id = ?').run(chatId);
  // Clearing the conversation stops any active route monitor (which removes its
  // own auto-created route watches). Manual kill-watch subscriptions are
  // deliberate persistent state, NOT conversation history, so they are kept.
  stopRouteMonitor(chatId, 'manual');
  return threads.length;
}

// ---------------------------------------------------------------------------
// In-flight request tracking (shared across platforms; keyspaces are disjoint)
// ---------------------------------------------------------------------------

const inFlightRequests = new Map<number, {
  token: string;
  threadId: string;
  text: string;
  startedAt: number;
}>();

export function hasInFlightRequest(chatId: number): boolean {
  return inFlightRequests.has(chatId);
}

export function activeRequestCount(): number {
  return inFlightRequests.size;
}

export function isDuplicateInFlightRequest(chatId: number, threadId: string, text: string, now = Date.now()): boolean {
  const current = inFlightRequests.get(chatId);
  if (!current) return false;
  if (current.threadId !== threadId) return false;
  if (current.text !== text) return false;
  return now - current.startedAt < DUPLICATE_REQUEST_WINDOW_MS;
}

export function rememberInFlightRequest(chatId: number, threadId: string, text: string, token: string, startedAt = Date.now()): void {
  inFlightRequests.set(chatId, {
    token,
    threadId,
    text,
    startedAt,
  });
}

export function clearInFlightRequest(chatId: number, token?: string): void {
  const current = inFlightRequests.get(chatId);
  if (!current) return;
  if (token && current.token !== token) return;
  inFlightRequests.delete(chatId);
}

// ---------------------------------------------------------------------------
// Rate limiting (shared sliding window per user across platforms)
// ---------------------------------------------------------------------------

const recentRequestStarts = new Map<string, number[]>();

export interface ChatRequestAllowanceInput {
  chatId: number;
  userId: number;
  hasActiveRequest: boolean;
  activeRequestCount: number;
  now?: number;
}

export interface ChatRequestAllowance {
  ok: boolean;
  message: string | null;
}

export function evaluateChatRequestAllowance(input: ChatRequestAllowanceInput): ChatRequestAllowance {
  if (input.hasActiveRequest) {
    return {
      ok: false,
      message: 'Предыдущий запрос ещё обрабатывается. Дождись ответа и попробуй снова.',
    };
  }

  const maxActiveRequests = normalizePositiveInt(
    config.telegram.maxActiveRequestsGlobal,
    DEFAULT_MAX_ACTIVE_REQUESTS,
  );
  if (input.activeRequestCount >= maxActiveRequests) {
    return {
      ok: false,
      message: 'Сервис сейчас перегружен. Попробуй ещё раз чуть позже.',
    };
  }

  const now = input.now ?? Date.now();
  const windowMs = normalizePositiveInt(config.telegram.requestWindowMs, DEFAULT_REQUEST_WINDOW_MS);
  const maxRequestsPerWindow = normalizePositiveInt(
    config.telegram.maxRequestsPerWindow,
    DEFAULT_MAX_REQUESTS_PER_WINDOW,
  );

  const key = buildActorKey(input.chatId, input.userId);
  const recent = pruneRecentRequests(recentRequestStarts.get(key) ?? [], now, windowMs);
  if (recent.length >= maxRequestsPerWindow) {
    recentRequestStarts.set(key, recent);
    return {
      ok: false,
      message: `Слишком много запросов за короткое время. Подожди ${Math.ceil(windowMs / 1000)} секунд и попробуй снова.`,
    };
  }

  recent.push(now);
  recentRequestStarts.set(key, recent);
  return { ok: true, message: null };
}

export function resetChatRequestGuardForTests(): void {
  recentRequestStarts.clear();
  inFlightRequests.clear();
}

function buildActorKey(chatId: number, userId: number): string {
  return userId > 0 ? `u:${userId}` : `c:${chatId}`;
}

function pruneRecentRequests(values: number[], now: number, windowMs: number): number[] {
  return values.filter((value) => now - value < windowMs);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.round(value);
}

// ---------------------------------------------------------------------------
// Agent turn
// ---------------------------------------------------------------------------

export async function runAgentTurn(
  db: Db,
  threadId: string,
  ctx: UserContext,
  text: string,
): Promise<string> {
  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'user', text);
  void maybeRefreshUserProfile(db, ctx);
  const agentResult = await handleAgentMessage(db, threadId, ctx, text);
  return finalizeThreadMessage(db, threadId, agentResult.text);
}

export async function maybeRefreshUserProfile(db: Db, ctx: UserContext): Promise<void> {
  const refreshSeconds = config.userProfile.refreshSeconds;
  if (!refreshSeconds || refreshSeconds <= 0) return;
  const profile = await readUserProfile(db, ctx);
  if (!profile) {
    void refreshUserProfile(db, ctx).catch(() => {});
    return;
  }
  const match = /^Updated:\s*(.+)$/m.exec(profile);
  if (!match) {
    void refreshUserProfile(db, ctx).catch(() => {});
    return;
  }
  const updatedAt = Date.parse(match[1]);
  if (!Number.isFinite(updatedAt)) {
    void refreshUserProfile(db, ctx).catch(() => {});
    return;
  }
  const ageSeconds = (Date.now() - updatedAt) / 1000;
  if (ageSeconds >= refreshSeconds) {
    void refreshUserProfile(db, ctx).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Character switch summaries
// ---------------------------------------------------------------------------

const PROFILE_REFRESH_TIMEOUT_MS = 10_000;

export async function refreshAndSummarize(
  db: Db,
  userCtx: UserContext,
  charName: string,
  characterId: number,
): Promise<string> {
  let profileContent: string | null = null;
  try {
    const result = await Promise.race([
      refreshUserProfile(db, userCtx),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROFILE_REFRESH_TIMEOUT_MS)),
    ]);
    if (result && result.ok) {
      profileContent = await readUserProfile(db, userCtx);
    }
  } catch {
    // profile will refresh later on next message
  }

  if (!profileContent) {
    return `Активный персонаж: ${charName} (${characterId}).`;
  }

  return formatProfileSummary(profileContent, charName, characterId);
}

export function formatProfileSummary(profile: string, characterName: string, characterId: number): string {
  const lines: string[] = [`Активный персонаж: ${characterName} (${characterId})`];

  const corpMatch = /^- Corporation:\s*(.+)$/m.exec(profile);
  if (corpMatch) lines.push(`Корп: ${corpMatch[1]}`);

  const allianceMatch = /^- Alliance:\s*(.+)$/m.exec(profile);
  if (allianceMatch) lines.push(`Альянс: ${allianceMatch[1]}`);

  const systemMatch = /^- System:\s*(.+)$/m.exec(profile);
  if (systemMatch) lines.push(`Система: ${systemMatch[1]}`);

  const shipMatch = /^- Ship:\s*(.+)$/m.exec(profile);
  if (shipMatch) lines.push(`Корабль: ${shipMatch[1]}`);

  const walletMatch = /^- Balance ISK:\s*(.+)$/m.exec(profile);
  if (walletMatch) lines.push(`ISK: ${walletMatch[1]}`);

  return lines.join('\n');
}

export function insertSwitchNotification(db: Db, chatId: number, characterId: number): void {
  const thread = db.prepare(
    'SELECT thread_id FROM agent_threads WHERE chat_id = ? AND character_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(chatId, characterId) as { thread_id: string } | undefined;

  if (!thread) return;

  db.prepare('INSERT INTO messages (thread_id, role, content) VALUES (?, ?, ?)').run(
    thread.thread_id,
    'user',
    '[System] Пользователь переключился на этого персонажа.',
  );
}

// ---------------------------------------------------------------------------
// Thinking phrases
// ---------------------------------------------------------------------------

const EVE_THINKING_PHRASES = [
  'Качаю Cybernetics V...',
  'Лью Large Skill Injector...',
  'Жду ответа от Aura...',
  'Сканирую сигнатуры...',
  'Запрашиваю данные с Jita 4-4...',
  'Прогреваю варп-двигатель...',
  'Калибрую D-Scan...',
  'Подключаюсь к CONCORD...',
  'Дешифрую данные Sleepers...',
  'Загружаю карго...',
  'Оптимизирую фиттинг...',
  'Анализирую killboard...',
  'Рассчитываю орбиту...',
  'Взламываю relic-контейнер...',
  'Запускаю дроны...',
  'Активирую клоаку...',
  'Перегружаю хардинеры...',
  'Обновляю маркет-ордера...',
  'Прыгаю через гейт...',
  'Докую в цитадель...',
];

export function pickThinkingPhrase(): string {
  return EVE_THINKING_PHRASES[Math.floor(Math.random() * EVE_THINKING_PHRASES.length)];
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

export function normalizeUiCommandError(error: string | null): string {
  const text = (error ?? '').trim();
  if (!text) {
    return 'Не удалось выполнить команду в клиенте EVE.';
  }
  if (text.includes('No EVE character linked') || text.includes('/eve_login')) {
    return 'Персонаж не привязан или сессия истекла. Используй /eve_login.';
  }
  if (text.includes('Missing scopes')) {
    return 'Для этой команды клиент EVE не дал нужный доступ. Перелогинься через /eve_login.';
  }
  return `Не удалось выполнить команду в клиенте EVE: ${text}`;
}

export function normalizeAgentRuntimeError(err: unknown): string {
  const combined = collectErrorText(err).toLowerCase();

  if (
    combined.includes('unsupported state or unable to authenticate data')
    || combined.includes('no valid eve access token')
    || combined.includes('no eve character linked')
    || combined.includes('missing scopes')
    || combined.includes('decryptstoredsecret')
  ) {
    return 'Связка с EVE устарела или повреждена. Перепривяжи персонажа через /eve_login.';
  }

  if (
    combined.includes('apiconnectionerror')
    || combined.includes('fetch failed')
    || combined.includes('econnrefused')
    || combined.includes('connect etimedout')
    || combined.includes('enotfound')
  ) {
    return 'LLM backend сейчас недоступен. Попробуй ещё раз чуть позже.';
  }

  if (combined.includes('429') || combined.includes('rate limit')) {
    return 'LLM backend перегружен или упёрся в лимит. Попробуй ещё раз чуть позже.';
  }

  if (combined.includes('401') || combined.includes('403') || combined.includes('authentication')) {
    return 'LLM backend отклонил авторизацию. Проверь настройки доступа.';
  }

  return 'Внутренняя ошибка. Попробуй ещё раз.';
}

function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || seen.has(item)) continue;
    seen.add(item);

    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }

    if (item instanceof Error) {
      parts.push(item.name, item.message);
      if ('cause' in item) {
        queue.push((item as Error & { cause?: unknown }).cause);
      }
      continue;
    }

    if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      if (typeof record.message === 'string') parts.push(record.message);
      if (typeof record.code === 'string') parts.push(record.code);
      if (typeof record.type === 'string') parts.push(record.type);
      if ('cause' in record) queue.push(record.cause);
    }
  }

  return parts.join(' ');
}
