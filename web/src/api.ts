import type { ActivityStep, ChatMessage, Conversation, SessionPayload } from './types';

type ErrorPayload = { error?: string };

async function request<T>(
  path: string,
  init: RequestInit = {},
  csrfToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as ErrorPayload;
    throw new Error(payload.error || 'Не удалось выполнить запрос.');
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export const webApi = {
  getSession: () => request<SessionPayload>('/api/web/session'),
  createSession: () => request<SessionPayload>('/api/web/session', { method: 'POST' }),
  logout: (csrfToken: string) => request<void>('/api/web/session', { method: 'DELETE' }, csrfToken),
  startEveLogin: (csrfToken: string) => request<{ url: string }>(
    '/api/web/eve/login',
    { method: 'POST' },
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
  sendMessage: (message: string, threadId: string | null, csrfToken: string) => request<{
    threadId: string;
    message: string;
    activity: ActivityStep[];
  }>('/api/web/chat', {
    method: 'POST',
    body: JSON.stringify({ message, threadId }),
  }, csrfToken),
};
