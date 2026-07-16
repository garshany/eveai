import { config } from '../config.js';
import {
  DEFAULT_EVE_ACCESS_GROUPS,
  EVE_ACCESS_GROUP_IDS,
  type EveAccessGroupId,
} from '../eve/scopes.js';
import { CONSENT_STYLES, EVE_ACCESS_GROUP_COPY } from './eve-consent.js';

export type ConsentLocale = 'ru' | 'en';

export function buildLocalizedEveConsentPage(
  state: string,
  locale: ConsentLocale,
  error?: string,
): string {
  const ru = locale === 'ru';
  const cancelPath = config.web.chatEnabled ? '/app' : '/health';
  const defaults = new Set<EveAccessGroupId>(DEFAULT_EVE_ACCESS_GROUPS);
  const groups = EVE_ACCESS_GROUP_IDS.map((groupId) => {
    const copy = EVE_ACCESS_GROUP_COPY[groupId];
    return `<label class="access-card${copy.sensitive ? ' access-card--sensitive' : ''}">
      <input type="checkbox" name="access" value="${groupId}"${defaults.has(groupId) ? ' checked' : ''}>
      <span class="access-card__check" aria-hidden="true"></span>
      <span class="access-card__copy"><strong>${escapeHtml(ru ? copy.ruTitle : copy.enTitle)}</strong><span>${escapeHtml(ru ? copy.ruDescription : copy.enDescription)}</span></span>
      ${copy.sensitive ? `<em>${ru ? 'ДЕЙСТВИЯ' : 'WRITE'}</em>` : ''}
    </label>`;
  }).join('');
  const copy = ru ? RU : EN;
  const switchLocale: ConsentLocale = ru ? 'en' : 'ru';
  const switchLabel = ru ? 'EN' : 'RU';
  const switchUrl = `/auth/eve/login?state=${encodeURIComponent(state)}&language=${switchLocale}`;

  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>EVE AI — ${escapeHtml(copy.pageTitle)}</title>
  <style>${CONSENT_STYLES}.language-switch{margin-left:16px;padding:8px 11px;border:1px solid var(--border);color:var(--accent2);font-size:12px;text-decoration:none}.language-switch:hover{border-color:var(--accent)}</style>
</head>
<body>
  <main class="shell">
    <header class="brand"><span class="brand__mark">✦</span><span>EVE <strong>AI</strong></span><span class="brand__step">EVE SSO · 01</span><a class="language-switch" href="${switchUrl}" hreflang="${switchLocale}">${switchLabel}</a></header>
    <section class="hero"><div><p class="eyebrow">${escapeHtml(copy.eyebrow)}</p><h1>${escapeHtml(copy.heading)}</h1></div><p class="lead">${escapeHtml(copy.lead)}</p></section>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/auth/eve/consent" class="consent-form">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="language" value="${locale}">
      <section class="identity-card"><span class="identity-card__number">01</span><div><strong>${escapeHtml(copy.identityTitle)}</strong><p>${escapeHtml(copy.identityText)}</p></div><span class="required">${escapeHtml(copy.always)}</span></section>
      <section class="access-section" aria-labelledby="access-title"><div class="section-heading"><div><span>02</span><h2 id="access-title">${escapeHtml(copy.accessTitle)}</h2></div><p>${escapeHtml(copy.accessLead)}</p></div><div class="access-grid">${groups}</div></section>
      <section class="data-flow" aria-labelledby="flow-title"><div class="section-heading"><div><span>03</span><h2 id="flow-title">${escapeHtml(copy.flowTitle)}</h2></div></div><div class="flow-grid">
        <article><strong>ESI → ${escapeHtml(copy.server)}</strong><p>${escapeHtml(copy.esiFlow)}</p></article>
        <article><strong>${escapeHtml(copy.server)} → AI</strong><p>${escapeHtml(copy.aiFlow)}</p></article>
        <article><strong>${escapeHtml(copy.storageTitle)}</strong><p>${escapeHtml(copy.storageText)}</p></article>
        <article><strong>${escapeHtml(copy.limitsTitle)}</strong><p>${escapeHtml(copy.limitsText)}</p></article>
      </div></section>
      <section class="acknowledgement"><label class="acknowledgement__check"><input type="checkbox" name="accepted" value="yes" required><span>${escapeHtml(copy.acknowledgement)}</span></label><div class="actions"><button type="submit">${escapeHtml(copy.continue)}</button><a href="${cancelPath}">${escapeHtml(copy.cancel)}</a></div></section>
    </form>
    <footer><p>${copy.revokePrefix} <a href="https://developers.eveonline.com/authorized-apps" target="_blank" rel="noreferrer">Authorized Apps</a>.</p><p><a href="https://developers.eveonline.com/license-agreement" target="_blank" rel="noreferrer">Developer License Agreement</a> · <a href="https://developers.eveonline.com/docs/services/sso/" target="_blank" rel="noreferrer">EVE SSO</a></p><p class="legal">${escapeHtml(copy.legal)}</p></footer>
  </main>
</body>
</html>`;
}

const RU = {
  pageTitle: 'согласие EVE SSO', eyebrow: 'КОНТРОЛЬ ДОСТУПА', heading: 'Вы решаете, что видит агент.',
  lead: 'Все приватные категории необязательны. Снимите любой флажок или оставьте только вход по имени персонажа.',
  identityTitle: 'Вход по персонажу', identityText: 'CCP передаст ID и имя выбранного персонажа для входа и привязки профиля. Пароль EVE приложение не получает.', always: 'ВСЕГДА',
  accessTitle: 'Выберите приватные данные', accessLead: 'По умолчанию отмечена только навигация. Любую категорию можно не предоставлять; действия записи выделены отдельно.',
  flowTitle: 'Как используются данные', server: 'сервер', esiFlow: 'Выбранные данные запрашиваются только через официальный ESI. Access/refresh tokens хранятся на сервере в зашифрованном виде.',
  aiFlow: 'Обычный запрос может передать AI-модели ваше сообщение, контекст беседы, сохранённый профиль и результаты нужных инструментов. EVE-токены модели не передаются.',
  storageTitle: 'Хранение', storageText: 'Сервер хранит выбранные scope, профиль и историю чата. Выход удаляет браузерную сессию и её данные.',
  limitsTitle: 'Ограничение доступа', limitsText: 'Без выбранной категории агент продолжит работать с публичными данными, но функции, требующие отсутствующего scope, будут недоступны.',
  acknowledgement: 'Я понимаю, какие данные будут запрошены и как выбранные данные использует EVE AI. Я разрешаю доступ только к отмеченным категориям.',
  continue: 'Продолжить в EVE SSO →', cancel: 'Отмена', revokePrefix: 'Доступ можно отозвать в',
  legal: 'EVE AI — стороннее приложение; оно не связано с CCP Games и не одобрено CCP.',
};

const EN: typeof RU = {
  pageTitle: 'EVE SSO consent', eyebrow: 'ACCESS CONTROL', heading: 'You decide what the agent can see.',
  lead: 'Every private category is optional. Clear any checkbox or use character identity only.',
  identityTitle: 'Character sign-in', identityText: 'CCP provides the selected character ID and name for sign-in and profile linking. The app never receives your EVE password.', always: 'ALWAYS',
  accessTitle: 'Choose private data', accessLead: 'Only navigation is selected by default. You may withhold any category; write actions are separated.',
  flowTitle: 'How data is used', server: 'server', esiFlow: 'Selected data is requested only through official ESI. Access and refresh tokens are encrypted at rest on the server.',
  aiFlow: 'A normal request may send the AI model your message, conversation context, stored profile, and required tool results. EVE tokens are never sent to the model.',
  storageTitle: 'Storage', storageText: 'The server stores selected scopes, profile data, and chat history. Logout removes the browser session and its data.',
  limitsTitle: 'Access limits', limitsText: 'Without a selected category, the agent still uses public data, but features requiring a missing scope are unavailable.',
  acknowledgement: 'I understand what data will be requested and how EVE AI uses selected data. I authorize access only to the checked categories.',
  continue: 'Continue to EVE SSO →', cancel: 'Cancel', revokePrefix: 'Access can be revoked in',
  legal: 'EVE AI is a third-party application and is not affiliated with or endorsed by CCP Games.',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] ?? character);
}
