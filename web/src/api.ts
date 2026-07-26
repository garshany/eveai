import type { ChatMessage, Conversation, PilotProfile, ScanPayload, SessionPayload, WebAgentRequest } from './types';
import type { Locale } from './i18n';

type ErrorPayload = { error?: string };

export class AmbiguousApiRequestError extends Error {
  readonly ambiguous = true;
}

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isAmbiguousApiRequestError(error: unknown): error is AmbiguousApiRequestError {
  return error instanceof AmbiguousApiRequestError;
}

function httpErrorMessage(status: number, serverMessage?: string): string {
  if (status === 401 || status === 403) {
    return serverMessage || 'Сессия истекла. Обновите страницу и войдите снова.';
  }
  if (status === 429) {
    return serverMessage || 'Слишком много запросов. Подождите немного и повторите.';
  }
  if (status >= 500) {
    return serverMessage || 'Сервер временно недоступен. Попробуйте позже.';
  }
  return serverMessage || 'Не удалось выполнить запрос.';
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  csrfToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: 'same-origin',
    });
  } catch {
    throw new AmbiguousApiRequestError('Соединение с сервером прервано. Повторяем безопасно.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as ErrorPayload;
    throw new ApiRequestError(response.status, httpErrorMessage(response.status, payload.error));
  }
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw new AmbiguousApiRequestError('Сервер принял запрос, но ответ не удалось прочитать.');
  }
}

export const webApi = {
  getSession: () => request<SessionPayload>('/api/web/session'),
  createSession: (turnstileToken?: string) => request<SessionPayload>('/api/web/session', {
    method: 'POST',
    body: JSON.stringify({ turnstileToken }),
  }),
  logout: (csrfToken: string) => request<void>('/api/web/session', { method: 'DELETE' }, csrfToken),
  startEveLogin: (csrfToken: string, locale: Locale) => request<{ url: string }>(
    '/api/web/eve/login',
    { method: 'POST', body: JSON.stringify({ language: locale }) },
    csrfToken,
  ),
  activateCharacter: (characterId: number, csrfToken: string) => request<SessionPayload>(
    `/api/web/characters/${encodeURIComponent(characterId)}/activate`,
    { method: 'POST' },
    csrfToken,
  ),
  listConversations: () => request<{ conversations: Conversation[] }>('/api/web/conversations'),
  createConversation: (csrfToken: string) => request<{ threadId: string }>(
    '/api/web/conversations',
    { method: 'POST' },
    csrfToken,
  ),
  deleteConversation: (threadId: string, csrfToken: string) => request<void>(
    `/api/web/conversations/${encodeURIComponent(threadId)}`,
    { method: 'DELETE' },
    csrfToken,
  ),
  getMessages: (threadId: string) => request<{ messages: ChatMessage[] }>(
    `/api/web/conversations/${encodeURIComponent(threadId)}/messages`,
  ),
  sendMessage: (
    message: string,
    threadId: string | null,
    idempotencyKey: string,
    csrfToken: string,
  ) => request<{
    request: WebAgentRequest;
    existing: boolean;
    pollUrl: string;
    cancelUrl: string;
    eventsUrl: string;
  }>('/api/web/chat', {
    method: 'POST',
    body: JSON.stringify({ message, threadId, idempotencyKey }),
  }, csrfToken),
  getAgentRequest: (requestId: string) => request<{ request: WebAgentRequest }>(
    `/api/web/chat/requests/${encodeURIComponent(requestId)}`,
  ),
  getActiveAgentRequest: (threadId?: string | null) => request<{ request: WebAgentRequest | null }>(
    `/api/web/chat/requests/active${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ''}`,
  ),
  cancelAgentRequest: (requestId: string, csrfToken: string) => request<{ request: WebAgentRequest }>(
    `/api/web/chat/requests/${encodeURIComponent(requestId)}`,
    { method: 'DELETE' },
    csrfToken,
  ),
  getProfile: () => request<{ profile: PilotProfile | null }>('/api/web/profile'),
  getScan: () => request<ScanPayload>('/api/web/scan'),
  stopScan: (csrfToken: string) => request<void>('/api/web/scan/stop', { method: 'POST' }, csrfToken),
};
