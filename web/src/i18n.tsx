import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'ru' | 'en';

const RU = {
  chat: 'Чат', profile: 'Профиль пилота', newChat: 'Новый диалог', conversations: 'Диалоги',
  noConversations: 'Первый диалог появится после вашего вопроса.', closeMenu: 'Закрыть меню', openMenu: 'Открыть меню',
  guest: 'Гостевой режим', connectPilot: 'Подключить персонажа', pilotConnected: 'Персонаж подключён', pilots: 'Капсулёры', active: 'активен', addPilot: 'Добавить капсулёра', logout: 'Выйти',
  serviceReady: 'Системы доступны', loginLine1: 'Разведка', loginLine2: 'начинается с вопроса',
  loginLead: 'Подключите персонажа, чтобы получать ответы с учётом ваших маршрутов, активов и ситуации в Новом Эдеме.',
  loginEve: 'Войти через EVE Online', ssoMissing: 'EVE SSO не настроен', guestContinue: 'Продолжить без подключения', revocable: 'Доступ можно отозвать в любой момент',
  privacy: 'Конфиденциальность', serviceStatus: 'Статус сервиса', understood: 'Понятно',
  privacyText: 'Токены EVE хранятся только на сервере в зашифрованном виде. Браузер получает HttpOnly-сессию и никогда не видит ключи провайдера или ESI.',
  connected: 'Подключено', introTitle: 'Чем займёмся, капсулёр?', introLead: 'Маршруты, рынок, разведка и разбор боёв — в одном диалоге.',
  suggestionRoute: 'Построй безопасный маршрут', suggestionMarket: 'Сравни цены в регионах', suggestionLosses: 'Разбери последние потери',
  placeholder: 'Спросите о Новом Эдеме…', message: 'Сообщение', send: 'Отправить сообщение', attachments: 'Вложения пока недоступны', thinking: 'Модель формирует ответ', cancelRequest: 'Отменить запрос',
  checkedSources: 'Проверено источников', completed: 'Завершено',
  profileTitle: 'Профиль пилота', profileLead: 'Активный капсулёр и доступные данные ESI', noPilot: 'Подключите персонажа, чтобы открыть профиль.',
  corporation: 'Корпорация', alliance: 'Альянс', location: 'Местоположение', ship: 'Корабль', skills: 'Навыки', wallet: 'Кошелёк', security: 'Безопасность', born: 'Создан', online: 'В сети', offline: 'Не в сети', unavailable: 'Недоступно', missingScope: 'Нет разрешения', queued: 'в очереди', skillPoints: 'SP', balance: 'Баланс', refresh: 'Обновить',
  loading: 'Загрузка', requestFailed: 'Не удалось выполнить запрос.',
  requestQueued: 'Запрос в очереди', requestRunning: 'Агент формирует ответ', toolCalls: 'Вызовы инструментов', agentComposing: 'Агент печатает ответ',
  copyCode: 'Копировать код', copied: 'Скопировано', dismissError: 'Скрыть ошибку', scrollToLatest: 'К новым сообщениям',
  composerHint: 'Enter — отправить, Shift+Enter — новая строка', turnstileLoading: 'Загрузка проверки защиты…',
  turnstileFailed: 'Проверка не прошла.', retry: 'Повторить',
  market: 'Маркет', marketLead: 'Книга ордеров торговых регионов из локального снапшота',
  marketRegion: 'Регион', marketSearchPlaceholder: 'Найти товар…', marketSearchHint: 'Минимум 2 символа', marketSearchEmpty: 'Ничего не найдено',
  marketGroups: 'Группы товаров', marketGroupsEmpty: 'Пустая группа', marketSelectItem: 'Выберите товар через поиск или дерево групп.',
  marketBestSell: 'Лучшая продажа', marketBestBuy: 'Лучшая покупка', marketSpread: 'Спред',
  marketSellVolume: 'Объём продажи', marketBuyVolume: 'Объём покупки', marketOrdersCount: 'ордеров',
  marketDataJustNow: 'Данные только что обновлены', marketDataAge: 'Данные {age} мин назад', marketDataUnknown: 'Возраст данных неизвестен',
  marketSnapshotStale: 'Снапшот устарел', marketSnapshotNotLoaded: 'Снапшот рынка ещё не загружен', marketUpdatedAt: 'Обновлено {time}',
  marketTabBook: 'Ордер-бук', marketTabAnalytics: 'Аналитика', marketTabWatchlist: 'Вотчлист и алерты',
  marketSellSide: 'Продажа', marketBuySide: 'Покупка', marketPrice: 'Цена', marketQuantity: 'Кол-во', marketLocation: 'Локация',
  marketPlayerStructure: 'Структура игрока', marketShowMore: 'Показать ещё', marketNoOrders: 'Ордеров нет',
  marketChartTitle: 'История цен', marketChartRange30: '30 дней', marketChartRange90: '90 дней', marketChartRange365: 'Год', marketChartRangeAll: 'Всё',
  marketChartEmpty: 'История цен для этого товара пока пуста.', marketChartSparse: 'Данных мало — показано всё, что накоплено.',
  marketChartAria: 'График истории цен', marketChartAverage: 'Средняя', marketChartHighest: 'Максимум', marketChartLowest: 'Минимум', marketChartVolume: 'Объём',
  marketChartChange7d: 'Изменение 7д', marketChartChange30d: 'Изменение 30д', marketChartChange90d: 'Изменение 90д',
  marketChartVolatility: 'Волатильность', marketChartAvgVolume: 'Ср. дневной объём', marketChartTrend: 'Тренд', marketChartPerDay: '{value}/день',
  marketCompareTitle: 'Сравнение регионов', marketCompareEmpty: 'Нет ордеров по этому товару ни в одном регионе.',
  marketWatchlistTitle: 'Вотчлист', marketWatchlistItem: 'Товар', marketWatchlistEmpty: 'Список пуст. Добавьте текущий товар кнопкой выше.',
  marketWatchlistAdd: 'Добавить текущий товар', marketWatchlistRemove: 'Удалить из списка',
  marketAlertsTitle: 'Ценовые алерты', marketAlertSide: 'Сторона', marketAlertCondition: 'Условие',
  marketAlertAbove: 'Выше (≥)', marketAlertBelow: 'Ниже (≤)', marketAlertThreshold: 'Пороговая цена', marketAlertCreate: 'Создать алерт',
  marketAlertNoItem: 'Выберите товар, чтобы создать алерт.', marketAlertActive: 'Активные', marketAlertTriggered: 'Сработавшие',
  marketAlertEmpty: 'Активных алертов нет.', marketAlertTriggeredEmpty: 'Срабатываний пока не было.', marketAlertDelete: 'Удалить алерт',
  marketAlertBestNow: 'Сейчас', marketAlertDistance: '{pct} до срабатывания', marketAlertDelivered: 'push отправлен', marketAlertWebOnly: 'только в вебе',
  marketAlertThresholdCrossed: 'Порог уже пройден',
} as const;

const EN: Record<keyof typeof RU, string> = {
  chat: 'Chat', profile: 'Pilot profile', newChat: 'New chat', conversations: 'Conversations',
  noConversations: 'Your first conversation appears after a question.', closeMenu: 'Close menu', openMenu: 'Open menu',
  guest: 'Guest mode', connectPilot: 'Connect character', pilotConnected: 'Character connected', pilots: 'Capsuleers', active: 'active', addPilot: 'Add capsuleer', logout: 'Log out',
  serviceReady: 'Systems online', loginLine1: 'Intelligence', loginLine2: 'starts with a question',
  loginLead: 'Connect a character for answers based on your routes, assets, and the current situation in New Eden.',
  loginEve: 'Sign in with EVE Online', ssoMissing: 'EVE SSO is not configured', guestContinue: 'Continue without connecting', revocable: 'Access can be revoked at any time',
  privacy: 'Privacy', serviceStatus: 'Service status', understood: 'Got it',
  privacyText: 'EVE tokens are encrypted and stored only on the server. The browser receives an HttpOnly session and never sees provider or ESI credentials.',
  connected: 'Connected', introTitle: 'What are we doing, capsuleer?', introLead: 'Routes, markets, intelligence, and combat analysis in one conversation.',
  suggestionRoute: 'Build a safe route', suggestionMarket: 'Compare regional prices', suggestionLosses: 'Analyze recent losses',
  placeholder: 'Ask about New Eden…', message: 'Message', send: 'Send message', attachments: 'Attachments are not available yet', thinking: 'The model is preparing an answer', cancelRequest: 'Cancel request',
  checkedSources: 'Sources checked', completed: 'Completed',
  profileTitle: 'Pilot profile', profileLead: 'Active capsuleer and available ESI data', noPilot: 'Connect a character to open the profile.',
  corporation: 'Corporation', alliance: 'Alliance', location: 'Location', ship: 'Ship', skills: 'Skills', wallet: 'Wallet', security: 'Security', born: 'Created', online: 'Online', offline: 'Offline', unavailable: 'Unavailable', missingScope: 'Permission not granted', queued: 'queued', skillPoints: 'SP', balance: 'Balance', refresh: 'Refresh',
  loading: 'Loading', requestFailed: 'Request failed.',
  requestQueued: 'Request queued', requestRunning: 'The agent is composing an answer', toolCalls: 'Tool calls', agentComposing: 'Agent is composing a reply',
  copyCode: 'Copy code', copied: 'Copied', dismissError: 'Dismiss error', scrollToLatest: 'Jump to latest messages',
  composerHint: 'Enter to send, Shift+Enter for a new line', turnstileLoading: 'Loading bot protection…',
  turnstileFailed: 'Verification failed.', retry: 'Retry',
  market: 'Market', marketLead: 'Trade-region order book from the local snapshot',
  marketRegion: 'Region', marketSearchPlaceholder: 'Find an item…', marketSearchHint: 'At least 2 characters', marketSearchEmpty: 'No matches',
  marketGroups: 'Item groups', marketGroupsEmpty: 'Empty group', marketSelectItem: 'Pick an item via search or the group tree.',
  marketBestSell: 'Best sell', marketBestBuy: 'Best buy', marketSpread: 'Spread',
  marketSellVolume: 'Sell volume', marketBuyVolume: 'Buy volume', marketOrdersCount: 'orders',
  marketDataJustNow: 'Data just refreshed', marketDataAge: 'Data {age} min ago', marketDataUnknown: 'Data age unknown',
  marketSnapshotStale: 'Snapshot is stale', marketSnapshotNotLoaded: 'Market snapshot not loaded yet', marketUpdatedAt: 'Updated {time}',
  marketTabBook: 'Order book', marketTabAnalytics: 'Analytics', marketTabWatchlist: 'Watchlist & alerts',
  marketSellSide: 'Sell', marketBuySide: 'Buy', marketPrice: 'Price', marketQuantity: 'Qty', marketLocation: 'Location',
  marketPlayerStructure: 'Player structure', marketShowMore: 'Show more', marketNoOrders: 'No orders',
  marketChartTitle: 'Price history', marketChartRange30: '30 days', marketChartRange90: '90 days', marketChartRange365: '1 year', marketChartRangeAll: 'All',
  marketChartEmpty: 'No price history for this item yet.', marketChartSparse: 'Sparse data — showing everything stored so far.',
  marketChartAria: 'Price history chart', marketChartAverage: 'Average', marketChartHighest: 'High', marketChartLowest: 'Low', marketChartVolume: 'Volume',
  marketChartChange7d: '7d change', marketChartChange30d: '30d change', marketChartChange90d: '90d change',
  marketChartVolatility: 'Volatility', marketChartAvgVolume: 'Avg daily volume', marketChartTrend: 'Trend', marketChartPerDay: '{value}/day',
  marketCompareTitle: 'Region comparison', marketCompareEmpty: 'No orders for this item in any region.',
  marketWatchlistTitle: 'Watchlist', marketWatchlistItem: 'Item', marketWatchlistEmpty: 'The list is empty. Add the current item with the button above.',
  marketWatchlistAdd: 'Add current item', marketWatchlistRemove: 'Remove from watchlist',
  marketAlertsTitle: 'Price alerts', marketAlertSide: 'Side', marketAlertCondition: 'Condition',
  marketAlertAbove: 'Above (≥)', marketAlertBelow: 'Below (≤)', marketAlertThreshold: 'Threshold price', marketAlertCreate: 'Create alert',
  marketAlertNoItem: 'Select an item to create an alert.', marketAlertActive: 'Active', marketAlertTriggered: 'Triggered',
  marketAlertEmpty: 'No active alerts.', marketAlertTriggeredEmpty: 'No triggers yet.', marketAlertDelete: 'Delete alert',
  marketAlertBestNow: 'Now', marketAlertDistance: '{pct} to trigger', marketAlertDelivered: 'push sent', marketAlertWebOnly: 'web only',
  marketAlertThresholdCrossed: 'Threshold already crossed',
};

type I18nValue = { locale: Locale; setLocale: (locale: Locale) => void; t: (key: keyof typeof RU) => string };
const I18nContext = createContext<I18nValue | null>(null);
const STORAGE_KEY = 'eveai.locale.v1';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'ru');
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo<I18nValue>(() => ({ locale, setLocale, t: (key) => (locale === 'ru' ? RU[key] : EN[key]) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('I18nProvider is missing');
  return value;
}

export function LocaleSwitch() {
  const { locale, setLocale } = useI18n();
  return <button className="locale-switch" type="button" onClick={() => setLocale(locale === 'ru' ? 'en' : 'ru')} aria-label={locale === 'ru' ? 'Switch to English' : 'Переключить на русский'}>{locale === 'ru' ? 'EN' : 'RU'}</button>;
}
