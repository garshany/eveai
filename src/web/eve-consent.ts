import { config } from '../config.js';
import {
  DEFAULT_EVE_ACCESS_GROUPS,
  EVE_ACCESS_GROUP_IDS,
  isEveAccessGroupId,
  scopesForEveAccessGroups,
  type EveAccessGroupId,
} from '../eve/scopes.js';

export const EVE_CONSENT_VERSION = '2026-07-15.1';

type ConsentCopy = {
  ruTitle: string;
  enTitle: string;
  ruDescription: string;
  enDescription: string;
  sensitive?: boolean;
};

const GROUP_COPY: Record<EveAccessGroupId, ConsentCopy> = {
  navigation: {
    ruTitle: 'Навигация и текущий корабль',
    enTitle: 'Navigation and current ship',
    ruDescription: 'Местоположение, онлайн-статус, тип корабля и поиск структур.',
    enDescription: 'Location, online status, ship type, and structure search.',
  },
  character: {
    ruTitle: 'Персонаж и подготовка',
    enTitle: 'Character and progression',
    ruDescription: 'Навыки и очередь, клоны, импланты, контакты, LP, стендинги, титулы, медали, усталость прыжков, уведомления, исследования агентов, фитинги, личные киллмейлы, роли корпорации и данные флота.',
    enDescription: 'Skills and queue, clones, implants, contacts, loyalty points, standings, titles, medals, jump fatigue, notifications, research agents, fittings, personal killmails, corporation roles, and fleet data.',
  },
  economy: {
    ruTitle: 'Активы и экономика',
    enTitle: 'Assets and economy',
    ruDescription: 'Личные активы, кошелёк, ордера, рынки структур, производственные задания, чертежи, журнал добычи и контракты.',
    enDescription: 'Personal assets, wallet, orders, structure markets, industry jobs, blueprints, mining ledger, and contracts.',
  },
  communications: {
    ruTitle: 'Почта и календарь',
    enTitle: 'Mail and calendar',
    ruDescription: 'Чтение внутриигровой почты и событий календаря. Отправка сюда не входит.',
    enDescription: 'Read in-game mail and calendar events. Sending is not included.',
  },
  corporation: {
    ruTitle: 'Данные корпорации',
    enTitle: 'Corporation data',
    ruDescription: 'Членство, структуры и POS, чертежи, контакты, журналы контейнеров, контракты, дивизионы, объекты, медали, стендинги, титулы, таможни, кошельки, активы, производство, добыча, ордера, киллмейлы, FW-статистика и отслеживание участников.',
    enDescription: 'Membership, structures and starbases, blueprints, contacts, container logs, contracts, divisions, facilities, medals, standings, titles, customs offices, wallets, assets, industry, mining, orders, killmails, FW statistics, and member tracking.',
  },
  actions: {
    ruTitle: 'Действия от имени персонажа',
    enTitle: 'Actions on behalf of the character',
    ruDescription: 'Добавление маршрута и открытие окон в клиенте, управление и отправка почты, изменение флота, сохранение фитингов и управление планетами.',
    enDescription: 'Add client waypoints and open UI windows, manage and send mail, modify fleets, save fittings, and manage planets.',
    sensitive: true,
  },
};

export type ParsedEveConsent = {
  language: 'ru' | 'en';
  groupIds: EveAccessGroupId[];
  scopes: string[];
};

export function parseEveConsentForm(body: unknown): ParsedEveConsent | null {
  if (!body || typeof body !== 'object') return null;
  const values = body as Record<string, unknown>;
  if (values.accepted !== 'yes') return null;
  const language = values.language === 'en' ? 'en' : values.language === 'ru' ? 'ru' : null;
  if (!language) return null;

  const rawGroups = Array.isArray(values.access) ? values.access : values.access ? [values.access] : [];
  if (rawGroups.some((value) => typeof value !== 'string' || !isEveAccessGroupId(value))) return null;
  const groupIds = [...new Set(rawGroups as EveAccessGroupId[])];
  return { language, groupIds, scopes: scopesForEveAccessGroups(groupIds) };
}

export function buildEveConsentPage(state: string, error?: string): string {
  const providerName = escapeHtml(config.openai.providerName || 'AI provider');
  const cancelPath = config.web.chatEnabled ? '/app' : '/health';
  const defaultGroups = new Set<EveAccessGroupId>(DEFAULT_EVE_ACCESS_GROUPS);
  const groupRows = EVE_ACCESS_GROUP_IDS.map((groupId) => {
    const copy = GROUP_COPY[groupId];
    const checked = defaultGroups.has(groupId) ? ' checked' : '';
    return `
      <label class="access-card${copy.sensitive ? ' access-card--sensitive' : ''}">
        <input type="checkbox" name="access" value="${groupId}"${checked}>
        <span class="access-card__check" aria-hidden="true"></span>
        <span class="access-card__copy">
          <strong>${escapeHtml(copy.ruTitle)} <small lang="en">${escapeHtml(copy.enTitle)}</small></strong>
          <span>${escapeHtml(copy.ruDescription)}</span>
          <span lang="en">${escapeHtml(copy.enDescription)}</span>
        </span>
        ${copy.sensitive ? '<em><span lang="en">WRITE</span> / ДЕЙСТВИЯ</em>' : ''}
      </label>`;
  }).join('');

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='5' fill='%23030a12'/%3E%3Cpath d='M16 3l3 10 10 3-10 3-3 10-3-10-10-3 10-3z' fill='%23d9a441'/%3E%3C/svg%3E">
  <title>EVE AI — EVE SSO consent</title>
  <style>${CONSENT_STYLES}</style>
</head>
<body>
  <main class="shell">
    <header class="brand"><span class="brand__mark">✦</span><span>EVE <strong>AI</strong></span><span class="brand__step">EVE SSO · 01</span></header>
    <section class="hero">
      <div>
        <p class="eyebrow">КОНТРОЛЬ ДОСТУПА <span lang="en">· ACCESS CONTROL</span></p>
        <h1>Вы решаете, что видит агент.<span lang="en">You decide what the agent can see.</span></h1>
      </div>
      <p class="lead">Все приватные категории необязательны. Снимите любой флажок или оставьте только вход по имени персонажа.<span lang="en">Every private category is optional. Clear any checkbox or use character identity only.</span></p>
    </section>

    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}

    <form method="post" action="/auth/eve/consent" class="consent-form">
      <input type="hidden" name="state" value="${escapeHtml(state)}">

      <section class="identity-card">
        <span class="identity-card__number">01</span>
        <div><strong>Вход по персонажу <span lang="en">· Character sign-in</span></strong><p>CCP передаст ID и имя выбранного персонажа для входа и привязки профиля. Пароль EVE приложение не получает.<span lang="en">CCP provides the selected character ID and name for sign-in and profile linking. The app never receives your EVE password.</span></p></div>
        <span class="required">ВСЕГДА <span lang="en">· ALWAYS</span></span>
      </section>

      <section class="access-section" aria-labelledby="access-title">
        <div class="section-heading"><div><span>02</span><h2 id="access-title">Выберите приватные данные<small lang="en">Choose private data</small></h2></div><p>По умолчанию отмечена только навигация. Для полного режима можно выбрать остальные категории; действия записи выделены отдельно.<span lang="en">Only navigation is selected by default. Select other categories for broader answers; write actions are separated.</span></p></div>
        <div class="access-grid">${groupRows}</div>
      </section>

      <section class="data-flow" aria-labelledby="flow-title">
        <div class="section-heading"><div><span>03</span><h2 id="flow-title">Как используются данные<small lang="en">How data is used</small></h2></div></div>
        <div class="flow-grid">
          <article><strong>ESI → сервер</strong><p>Выбранные данные запрашиваются только через официальный ESI. Access/refresh tokens хранятся на сервере в зашифрованном виде.<span lang="en">Selected data is requested only through official ESI. Access and refresh tokens are encrypted at rest on the server.</span></p></article>
          <article><strong>Сервер → ${providerName}</strong><p>Каждый обычный запрос к ${providerName} может включать ваше сообщение, контекст беседы и сохранённый профиль EVE, если он есть. Профиль формируется из публичных EVE-данных и выбранных приватных разрешений и может содержать личность и принадлежность персонажа, статус и время входа, местоположение, корабль, навыки и атрибуты, очередь, импланты, клоны, фитинги и баланс кошелька. Нужные для вопроса результаты инструментов также передаются модели. EVE-токены не передаются.<span lang="en">Each normal request to ${providerName} may include your message, conversation context, and the stored EVE profile when available. The profile is built from public EVE data and selected private permissions and may contain character identity and affiliations, online/login status, location, ship, skills and attributes, queue, implants, clones, fittings, and wallet balance. Tool results needed for the question are also sent to the model. EVE tokens are never sent.</span></p></article>
          <article><strong>Хранение · Storage</strong><p>Сервер хранит выбранные scope, профиль и историю чата. Выход удаляет браузерную сессию и её данные; связи из Telegram, Discord или CLI сохраняются отдельно.<span lang="en">The server stores selected scopes, profile data, and chat history. Logout removes the browser lane; Telegram, Discord, or CLI links remain separate.</span></p></article>
          <article><strong>Ограничение · Limitation</strong><p>Без категории агент продолжит работать с публичными SDE/ESI и данными сообщества, но функции, требующие отсутствующего scope, будут недоступны.<span lang="en">Without a category, the agent still uses public SDE/ESI and community data, but features requiring a missing scope are unavailable.</span></p></article>
        </div>
      </section>

      <section class="acknowledgement">
        <fieldset>
          <legend>Язык записи согласия <span lang="en">· Consent record language</span></legend>
          <label><input type="radio" name="language" value="ru" checked> Русский</label>
          <label lang="en"><input type="radio" name="language" value="en"> English</label>
        </fieldset>
        <label class="acknowledgement__check">
          <input type="checkbox" name="accepted" value="yes" required>
          <span>Я понимаю, какие данные будут запрошены и как выбранные данные использует EVE AI Agent. Я разрешаю доступ только к отмеченным категориям.<small lang="en">I understand what data will be requested and how EVE AI Agent uses selected data. I authorize access only to the checked categories.</small></span>
        </label>
        <div class="actions">
          <button type="submit">Продолжить в EVE SSO <span lang="en">Continue to EVE SSO →</span></button>
          <a href="${cancelPath}">Отмена <span lang="en">· Cancel</span></a>
        </div>
      </section>
    </form>

    <footer>
      <p>Доступ можно отозвать в <a href="https://developers.eveonline.com/authorized-apps" target="_blank" rel="noreferrer">Authorized Apps</a>. <span lang="en">Access can be revoked at any time.</span></p>
      <p><a href="https://developers.eveonline.com/license-agreement" target="_blank" rel="noreferrer">Developer License Agreement</a> · <a href="https://developers.eveonline.com/docs/services/sso/" target="_blank" rel="noreferrer">EVE SSO documentation</a></p>
      <p class="legal">EVE AI Agent — стороннее приложение; оно не связано с CCP Games и не одобрено CCP. <span lang="en">EVE AI Agent is a third-party application and is not affiliated with or endorsed by CCP Games.</span></p>
    </footer>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] ?? character);
}

const CONSENT_STYLES = `
:root{color-scheme:dark;font-family:Inter,"Segoe UI",Arial,sans-serif;--bg:#030a12;--surface:#0b151f;--raised:#101c27;--text:#f0eee9;--muted:#9ba6b1;--border:#273644;--soft:#172530;--accent:#d9a441;--accent2:#f0bf5c;--danger:#d9776c}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 86% 4%,rgba(217,164,65,.08),transparent 28%),var(--bg);color:var(--text)}body:before{position:fixed;inset:0;pointer-events:none;content:"";background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(to bottom,#000,transparent 75%)}.shell{position:relative;width:min(1180px,calc(100% - 40px));margin:auto;padding:0 0 48px}.brand{display:flex;height:86px;align-items:center;gap:12px;border-bottom:1px solid var(--soft);font-size:21px;letter-spacing:.12em}.brand strong{color:var(--accent);font-weight:600}.brand__mark{color:var(--accent);font-size:32px}.brand__step{margin-left:auto;color:var(--muted);font-size:12px;letter-spacing:.16em}.hero{display:grid;padding:62px 0 46px;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr);gap:50px;align-items:end}.eyebrow{margin:0 0 17px;color:var(--accent);font-size:12px;letter-spacing:.18em}.hero h1{max-width:780px;margin:0;font-size:clamp(38px,5vw,68px);font-weight:360;line-height:1.08;letter-spacing:-.04em}.hero h1 span,.lead span,.identity-card p span,.section-heading p span,.flow-grid p span,.acknowledgement small,.legal span{display:block;margin-top:8px;color:var(--muted)}.lead{margin:0;color:#c1c7cd;font-size:16px;line-height:1.65}.error{padding:15px 18px;border:1px solid var(--danger);background:rgba(217,111,101,.08);color:#f2b0aa}.consent-form{display:grid;gap:22px}.identity-card,.access-section,.data-flow,.acknowledgement{border:1px solid var(--border);background:rgba(8,17,26,.9)}.identity-card{display:grid;padding:25px 28px;grid-template-columns:46px minmax(0,1fr) auto;gap:18px;align-items:start}.identity-card__number,.section-heading>div>span{color:var(--accent);font:600 12px/1 monospace;letter-spacing:.12em}.identity-card strong{font-size:18px;font-weight:520}.identity-card p{margin:8px 0 0;color:#c0c7ce;font-size:14px;line-height:1.6}.required{padding:6px 9px;border:1px solid rgba(107,201,138,.35);color:#7cd39a;font-size:10px;letter-spacing:.12em}.access-section,.data-flow,.acknowledgement{padding:30px}.section-heading{display:grid;margin-bottom:22px;grid-template-columns:minmax(0,1fr) minmax(260px,.8fr);gap:32px}.section-heading>div{display:grid;grid-template-columns:46px minmax(0,1fr);align-items:start}.section-heading h2{margin:-5px 0 0;font-size:25px;font-weight:430}.section-heading h2 small{display:block;margin-top:5px;color:var(--muted);font-size:13px;font-weight:400}.section-heading p{margin:0;color:#b8c1c9;font-size:13px;line-height:1.55}.access-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.access-card{position:relative;display:grid;min-height:122px;padding:20px;grid-template-columns:25px minmax(0,1fr);gap:14px;border:1px solid var(--border);background:var(--surface);cursor:pointer}.access-card:hover{border-color:#536474}.access-card:focus-within{outline:2px solid var(--accent2);outline-offset:3px}.access-card:has(input:checked){border-color:var(--accent);background:rgba(217,164,65,.055)}.access-card--sensitive:has(input:checked){border-color:var(--danger);background:rgba(217,111,101,.06)}.access-card input{position:absolute;width:1px;height:1px;opacity:0}.access-card__check{display:grid;width:22px;height:22px;border:1px solid #63717e;place-items:center}.access-card input:checked+.access-card__check{border-color:var(--accent);background:var(--accent)}.access-card input:checked+.access-card__check:after{content:"✓";color:#111820;font-weight:800}.access-card__copy strong{display:block;font-size:15px;font-weight:550}.access-card__copy strong small{display:block;margin-top:4px;color:var(--muted);font-size:12px;font-weight:400}.access-card__copy>span{display:block;margin-top:10px;color:#bcc4cb;font-size:12px;line-height:1.45}.access-card__copy>span[lang=en]{margin-top:4px;color:#7f8b96}.access-card em{position:absolute;top:16px;right:16px;color:var(--danger);font-size:9px;font-style:normal;letter-spacing:.1em}.flow-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--border)}.flow-grid article{padding:22px;background:var(--surface)}.flow-grid strong{color:var(--accent2);font-size:13px}.flow-grid p{margin:10px 0 0;color:#bdc5cc;font-size:13px;line-height:1.55}.acknowledgement{display:grid;gap:23px}.acknowledgement fieldset{display:flex;margin:0;padding:0;border:0;gap:18px;align-items:center}.acknowledgement legend{float:left;margin-right:auto;color:var(--muted);font-size:12px}.acknowledgement fieldset label{font-size:13px}.acknowledgement input{accent-color:var(--accent)}.acknowledgement__check{display:grid;padding:20px;border:1px solid var(--border);grid-template-columns:24px minmax(0,1fr);gap:14px;cursor:pointer}.acknowledgement__check:focus-within{outline:2px solid var(--accent2);outline-offset:3px}.acknowledgement__check input{width:19px;height:19px;margin:1px 0}.acknowledgement__check>span{font-size:14px;line-height:1.55}.actions{display:flex;align-items:center;gap:25px}.actions button{min-height:58px;padding:0 24px;border:1px solid var(--accent);background:#101b24;color:var(--accent2);font:550 14px/1 inherit;cursor:pointer}.actions button:hover{background:#17242e}.actions button span{display:block;margin-top:4px;color:#c9b47f;font-size:11px;font-weight:400}.actions a,footer a{color:#bdc6cd;text-underline-offset:3px}.actions>a{font-size:13px}footer{display:grid;margin-top:28px;padding-top:22px;border-top:1px solid var(--soft);grid-template-columns:1fr auto;gap:8px 30px;color:var(--muted);font-size:11px;line-height:1.5}footer p{margin:0}.legal{grid-column:1/-1}@media(max-width:760px){.shell{width:min(100% - 24px,1180px)}.brand{height:70px}.brand__step{display:none}.hero{padding:38px 2px 30px;grid-template-columns:1fr;gap:22px}.hero h1{font-size:38px}.identity-card{padding:20px;grid-template-columns:32px minmax(0,1fr)}.required{grid-column:2;justify-self:start}.access-section,.data-flow,.acknowledgement{padding:20px}.section-heading{grid-template-columns:1fr;gap:16px}.access-grid,.flow-grid{grid-template-columns:1fr}.access-card{min-height:auto;padding:17px}.acknowledgement fieldset{align-items:flex-start;flex-wrap:wrap}.acknowledgement legend{width:100%;margin-bottom:3px}.actions{align-items:stretch;flex-direction:column}.actions button{width:100%}footer{grid-template-columns:1fr}}
`;
