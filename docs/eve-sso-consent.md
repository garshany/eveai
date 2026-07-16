# EVE SSO Data Consent / Согласие на использование данных EVE SSO

Status: active
Consent version: `2026-07-15.1`

This document records the disclosure shown before every EVE SSO authorization
started from the browser, Telegram, Discord, or CLI. The rendered form is the
operative user-facing copy; this document is its durable review reference.

Этот документ фиксирует уведомление, которое показывается перед каждой
авторизацией EVE SSO из браузера, Telegram, Discord или CLI. Рабочим текстом для
пользователя является форма в приложении; этот документ нужен для проверки и
аудита версии.

## Required acknowledgement / Обязательное подтверждение

**RU**

> Я понимаю, какие данные будут запрошены и как выбранные данные использует
> EVE AI Agent. Я разрешаю доступ только к отмеченным категориям.

**EN**

> I understand what data will be requested and how EVE AI Agent uses selected
> data. I authorize access only to the checked categories.

The acknowledgement is mandatory. Private ESI access is not mandatory: the
player can clear every optional category and use EVE SSO only for the selected
character's ID and name. The agent still supports public SDE, public ESI, and
community data without private scopes.

Подтверждение обязательно. Доступ к приватным ESI-данным необязателен:
пользователь может снять все флажки и использовать EVE SSO только для ID и
имени выбранного персонажа. Без приватных scope агент продолжает работать с
публичными SDE, ESI и данными сообщества.

The accepted version, language, time, and resulting scope set remain attached
to the encrypted character authorization for as long as that authorization is
stored. Browser-only authorization and its consent record are removed together
when the browser lane is purged.

## Optional access groups / Необязательные группы доступа

| Group | Russian disclosure | English disclosure | Default |
| --- | --- | --- | --- |
| `navigation` | Местоположение, онлайн-статус, тип корабля и поиск структур | Location, online status, ship type, and structure search | selected |
| `character` | Навыки/очередь, клоны, импланты, контакты, LP, стендинги, титулы, медали, fatigue, уведомления, исследования агентов, фитинги, личные киллмейлы, роли и флот | Skills/queue, clones, implants, contacts, LP, standings, titles, medals, fatigue, notifications, research agents, fittings, personal killmails, roles, and fleet | off |
| `economy` | Активы, кошелёк, ордера, рынки структур, задания, чертежи, журнал добычи и контракты | Assets, wallet, orders, structure markets, jobs, blueprints, mining ledger, and contracts | off |
| `communications` | Чтение внутриигровой почты и календаря; без отправки | Read in-game mail and calendar; no sending | off |
| `corporation` | Членство, структуры/POS, чертежи, контакты, container logs, контракты, дивизионы, объекты, медали, стендинги, титулы, таможни, кошельки, активы, производство, добыча, ордера, киллмейлы, FW и tracking | Membership, structures/starbases, blueprints, contacts, container logs, contracts, divisions, facilities, medals, standings, titles, customs offices, wallets, assets, industry, mining, orders, killmails, FW, and tracking | off |
| `actions` | Маршруты и окна UI, управление/отправка почты, изменение флота, сохранение фитингов и управление планетами | Waypoints/UI windows, mail management/sending, fleet changes, fitting saves, and planet management | off, write warning |

The backend owns the exact scope mapping in `src/eve/scopes.ts`. The form sends
only group IDs; the server rejects unknown groups and never accepts raw scopes
from the browser.

## Data flow / Использование данных

**RU**

- CCP передаёт ID и имя выбранного персонажа. Пароль EVE приложение не получает.
- Только выбранные приватные данные запрашиваются через официальный ESI.
- Access/refresh tokens хранятся на сервере в зашифрованном виде и не
  передаются AI-модели.
- Каждый обычный запрос к настроенному оператором AI-провайдеру может включать
  сообщение пользователя, контекст беседы и сохранённый профиль EVE. Профиль
  строится из публичных EVE-данных и выбранных приватных разрешений и может содержать личность/принадлежность,
  статус и время входа, местоположение, корабль, навыки/атрибуты/очередь,
  импланты, клоны, фитинги и баланс кошелька. Нужные результаты инструментов
  также передаются модели.
- Сервер хранит выданные scope, профиль и историю чата. Выход удаляет
  браузерную сессию и её данные; связи того же пользователя через другие
  каналы остаются отдельными.
- При повторной авторизации старые профили во всех связанных каналах удаляются
  до активации нового набора scope; незавершённое обновление не может вернуть
  профиль, собранный с прежними разрешениями.
- Доступ можно отозвать на странице
  [EVE Authorized Apps](https://developers.eveonline.com/authorized-apps).

**EN**

- CCP provides the selected character ID and name. The app never receives the
  player's EVE password.
- Only selected private data is requested through official ESI.
- Access and refresh tokens are encrypted at rest on the server and are never
  sent to the AI model.
- Each normal request to the operator-configured AI provider may include the
  user message, conversation context, and the stored EVE profile. The profile
  is built from public EVE data and selected private permissions and may contain identity/affiliations,
  online/login status, location, ship, skills/attributes/queue, implants,
  clones, fittings, and wallet balance. Tool results needed for the question
  are also sent to the model.
- The server stores granted scopes, profile data, and chat history. Logout
  removes the browser lane and its data; links through other channels remain
  separate.
- On reauthorization, old profiles in every linked lane are removed before the
  new scope set becomes active; an in-flight refresh cannot restore a profile
  captured under the previous permissions.
- Access can be revoked through
  [EVE Authorized Apps](https://developers.eveonline.com/authorized-apps).

## CCP basis / Основание в правилах CCP

- [Developer License Agreement](https://developers.eveonline.com/license-agreement)
  prohibits tracking Player information or activity without the Player's
  express knowledge and consent and requires applicable privacy notices and
  authorizations.
- [EVE SSO documentation](https://developers.eveonline.com/docs/services/sso/)
  defines scopes as explicit permissions, states that ungranted scopes are not
  accessible, and says access can be revoked at any time.

EVE AI Agent is a third-party application and is not affiliated with or
endorsed by CCP Games.
