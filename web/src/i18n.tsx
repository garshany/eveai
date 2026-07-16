import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'ru' | 'en';

const RU = {
  chat: 'Чат', profile: 'Профиль пилота', scan: 'Онлайн-скан', newChat: 'Новый диалог', conversations: 'Диалоги',
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
  scanTitle: 'Онлайн-скан', scanLead: 'Живой монитор маршрута по ESI и EVE-KILL', feedLive: 'EVE-KILL REST feed работает', feedDown: 'EVE-KILL feed недоступен', noScan: 'Активного маршрута нет.', noScanLead: 'Попросите агента построить маршрут, включить автопилот и онлайн-скан.', startPrompt: 'Построй маршрут до Jita, включи автопилот и онлайн-скан', stopScan: 'Остановить скан', currentSystem: 'Текущая система', destination: 'Цель', progress: 'Прогресс', jumpsLeft: 'прыжков осталось', killsSeen: 'Сигналы на маршруте', dangerEvents: 'Последние угрозы', noThreats: 'Новых угроз не зафиксировано.', sourceRest: 'Один общий REST poller; браузер обновляет этот экран каждые 5 секунд.',
  loading: 'Загрузка', requestFailed: 'Не удалось выполнить запрос.',
} as const;

const EN: Record<keyof typeof RU, string> = {
  chat: 'Chat', profile: 'Pilot profile', scan: 'Live scan', newChat: 'New chat', conversations: 'Conversations',
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
  scanTitle: 'Live scan', scanLead: 'Live route monitor using ESI and EVE-KILL', feedLive: 'EVE-KILL REST feed is live', feedDown: 'EVE-KILL feed unavailable', noScan: 'No active route.', noScanLead: 'Ask the agent to build a route, set autopilot, and enable live scan.', startPrompt: 'Build a route to Jita, set autopilot, and enable live scan', stopScan: 'Stop scan', currentSystem: 'Current system', destination: 'Destination', progress: 'Progress', jumpsLeft: 'jumps remaining', killsSeen: 'Route signals', dangerEvents: 'Recent threats', noThreats: 'No new threats detected.', sourceRest: 'One shared REST poller; the browser refreshes this screen every 5 seconds.',
  loading: 'Loading', requestFailed: 'Request failed.',
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
