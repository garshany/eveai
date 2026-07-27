import type {
  ChatMessage,
  Conversation,
  MarketAiSearchResult,
  MarketAlert,
  MarketAlertEvent,
  MarketGroupTreeRow,
  MarketGroupTypeRow,
  MarketHistoryResponse,
  MarketOrderRow,
  MarketOrderSide,
  MarketOverview,
  MarketRegion,
  MarketRegionComparisonRow,
  MarketSnapshotMeta,
  MarketTypeInfo,
  MarketTypeSearchRow,
  MarketWatchlistItem,
  ModelSettingsPayload,
  MyTransparency,
  PilotProfile,
  SessionPayload,
  TransparencyPayload,
  WebAgentRequest,
} from './types';
import type { Locale } from './i18n';

type ErrorPayload = { error?: string };

export class AmbiguousApiRequestError extends Error {
  readonly ambiguous = true;
}

export class ApiRequestError extends Error {
  readonly status: number;
  /** Machine-readable error code when the server sent one (e.g. settings routes). */
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
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
    // A snake_case token is a machine-readable error code, not a user-facing
    // sentence — localized screens map it themselves; anything else stays a
    // server-provided message.
    const code = typeof payload.error === 'string' && /^[a-z][a-z0-9_]*$/.test(payload.error)
      ? payload.error
      : undefined;
    throw new ApiRequestError(response.status, httpErrorMessage(response.status, code ? undefined : payload.error), code);
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
  unlinkCharacter: (characterId: number, csrfToken: string) => request<void>(
    `/api/web/characters/${encodeURIComponent(characterId)}/unlink`,
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
  market: {
    status: () => request<{ snapshot: MarketSnapshotMeta }>('/api/web/market/status'),
    regions: () => request<{ regions: MarketRegion[] }>('/api/web/market/regions'),
    search: (q: string, limit?: number) => request<{ results: MarketTypeSearchRow[] }>(
      `/api/web/market/search?q=${encodeURIComponent(q)}${limit === undefined ? '' : `&limit=${limit}`}`,
    ),
    groups: (parent?: number | null) => request<{ groups: MarketGroupTreeRow[] }>(
      `/api/web/market/groups${parent === undefined || parent === null ? '' : `?parent=${parent}`}`,
    ),
    groupTypes: (groupId: number, limit?: number) => request<{ types: MarketGroupTypeRow[] }>(
      `/api/web/market/groups/${encodeURIComponent(groupId)}/types${limit === undefined ? '' : `?limit=${limit}`}`,
    ),
    overview: (typeId: number, regionId: number) => request<{ overview: MarketOverview }>(
      `/api/web/market/types/${encodeURIComponent(typeId)}/overview?region_id=${regionId}`,
    ),
    orders: (typeId: number, regionId: number, side: MarketOrderSide, offset?: number, limit?: number) => request<{ orders: MarketOrderRow[] }>(
      `/api/web/market/types/${encodeURIComponent(typeId)}/orders?region_id=${regionId}&side=${side}${offset === undefined ? '' : `&offset=${offset}`}${limit === undefined ? '' : `&limit=${limit}`}`,
    ),
    regionComparison: (typeId: number) => request<{ regions: MarketRegionComparisonRow[] }>(
      `/api/web/market/types/${encodeURIComponent(typeId)}/regions`,
    ),
    info: (typeId: number, lang: Locale) => request<{ info: MarketTypeInfo }>(
      `/api/web/market/types/${encodeURIComponent(typeId)}/info?lang=${lang}`,
    ),
    aiSearch: (query: string, regionId: number | null, csrfToken: string) => request<{ results: MarketAiSearchResult[] }>(
      '/api/web/market/ai-search',
      { method: 'POST', body: JSON.stringify({ query, region_id: regionId ?? undefined }) },
      csrfToken,
    ),
    history: (typeId: number, regionId: number, days?: number) => request<{ history: MarketHistoryResponse }>(
      `/api/web/market/types/${encodeURIComponent(typeId)}/history?region_id=${regionId}${days === undefined ? '' : `&days=${days}`}`,
    ),
    watchlist: {
      list: () => request<{ items: MarketWatchlistItem[] }>('/api/web/market/watchlist'),
      add: (typeId: number, regionId: number | undefined, csrfToken: string) => request<{ created: boolean; item: MarketWatchlistItem }>(
        '/api/web/market/watchlist',
        { method: 'POST', body: JSON.stringify({ type_id: typeId, region_id: regionId }) },
        csrfToken,
      ),
      remove: (typeId: number, regionId: number | undefined, csrfToken: string) => request<{ ok: true }>(
        `/api/web/market/watchlist/${encodeURIComponent(typeId)}${regionId === undefined ? '' : `?region_id=${regionId}`}`,
        { method: 'DELETE' },
        csrfToken,
      ),
    },
    alerts: {
      list: () => request<{ alerts: MarketAlert[] }>('/api/web/market/alerts'),
      create: (
        params: { typeId: number; regionId: number; side: MarketOrderSide; comparator: 'above' | 'below'; thresholdPrice: number },
        csrfToken: string,
      ) => request<{ alert: MarketAlert }>(
        '/api/web/market/alerts',
        {
          method: 'POST',
          body: JSON.stringify({
            type_id: params.typeId,
            region_id: params.regionId,
            side: params.side,
            comparator: params.comparator,
            threshold_price: params.thresholdPrice,
          }),
        },
        csrfToken,
      ),
      remove: (alertId: number, csrfToken: string) => request<{ ok: true }>(
        `/api/web/market/alerts/${encodeURIComponent(alertId)}`,
        { method: 'DELETE' },
        csrfToken,
      ),
      events: () => request<{ events: MarketAlertEvent[] }>('/api/web/market/alerts/events'),
    },
  },
  getTransparency: () => request<TransparencyPayload>('/api/web/transparency'),
  getMyTransparency: () => request<MyTransparency>('/api/web/transparency/me'),
  getModelSettings: () => request<ModelSettingsPayload>('/api/web/settings/model'),
  saveModelSettings: (
    body: { model: string; reasoning_effort: string; verbosity: string },
    csrfToken: string,
  ) => request<ModelSettingsPayload>('/api/web/settings/model', {
    method: 'PUT',
    body: JSON.stringify(body),
  }, csrfToken),
  resetModelSettings: (csrfToken: string) => request<ModelSettingsPayload>('/api/web/settings/model', {
    method: 'DELETE',
  }, csrfToken),
};
