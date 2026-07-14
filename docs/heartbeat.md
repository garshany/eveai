# Heartbeat — периодические проверки персонажа

## Что это

Heartbeat — фоновая система уведомлений. Проверяет состояние EVE-персонажа по расписанию и отправляет сводку в привязанный Telegram-чат или Discord DM, если есть изменения. Если ничего нового — молчит.

## Архитектура

```
app.ts (boot)
  └─ startHeartbeat(bot, db)
       └─ Cron('*/5 * * * *')          ← тикает каждые 5 минут
            └─ для каждого due юзера:
                 ├─ getEveCapabilities()  ← записать capability snapshot
                 ├─ runCheck('mail')      ← ESI: новые письма
                 ├─ runCheck('skills')    ← ESI: очередь скиллов
                 ├─ runCheck('wallet')    ← ESI: баланс ISK
                 ├─ runCheck(...)         ← остальные проверки
                 ├─ runModelText()        ← модель суммирует findings
                 ├─ deliverOutbound()     ← дождаться Telegram/Discord delivery
                 └─ saveState()           ← атомарно сохранить state после delivery
```

- Крон тикает часто (раз в 5 минут), но реально дёргает ESI только когда у юзера подошёл его интервал.
- Работает в том же процессе, что бот и Fastify. Без workers, queues, внешних cron.
- Зависимость: `croner` — lightweight cron scheduler для Node.js.

## Файлы

| Файл | Назначение |
|------|-----------|
| `src/scheduled/heartbeat-config.ts` | Tool для модели: enable/disable/set_interval/enable_check/disable_check/list |
| `src/scheduled/heartbeat-worker.ts` | Крон-воркер: тикает, проверяет, отправляет |
| `src/app.ts` | `startHeartbeat()` при старте, `stopHeartbeat()` при shutdown |

## Таблица `heartbeat_config`

```sql
CREATE TABLE heartbeat_config (
  user_id          INTEGER NOT NULL,
  character_id     INTEGER NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 0,
  interval_seconds INTEGER NOT NULL DEFAULT 3600,
  checks_json      TEXT NOT NULL DEFAULT '["mail"]',
  last_run_at      TEXT,
  last_mail_id     INTEGER,
  state_json       TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT,
  updated_at       TEXT,
  PRIMARY KEY (user_id, character_id)
);
```

- `checks_json` — массив включённых проверок: `["mail","skills","wallet"]`
- `state_json` — tracking state между запусками (last_mail_id, last_wallet_balance, last_skillqueue_ids, etc.)
- `interval_seconds` — индивидуальный интервал юзера (мин 300 сек / 5 мин, макс 604800 / 7 дней)

## Проверки

| Тип | ESI-эндпоинт | Когда уведомляет | State tracking |
|-----|-------------|------------------|----------------|
| `mail` | `get_characters_character_id_mail` + `mail_id` | Новые письма (mail_id > last) | `last_mail_id` |
| `skills` | `get_characters_character_id_skillqueue` | Скилл завершён / очередь пуста | `last_skillqueue_ids` |
| `wallet` | `get_characters_character_id_wallet` | Изменение баланса > 10M ISK | `last_wallet_balance` |
| `industry` | `get_characters_character_id_industry_jobs` | Job завершён (active → done) | `last_industry_job_ids` |
| `contracts` | `get_characters_character_id_contracts` | Новый входящий контракт | `last_contract_id` |
| `killmails` | `get_characters_character_id_killmails_recent` | Новый kill/loss | `last_killmail_id` |
| `orders` | `get_characters_character_id_orders` | Ордер исполнен/истёк | `last_order_ids` |
| `notifications` | `get_characters_character_id_notifications` | Война, структура под атакой, fuel alert | `last_notification_id` |
| `pi` | `get_characters_character_id_planets` | Экстрактор не обновлялся > 24ч | — |

### Логика первого запуска

Первый тик после включения записывает baseline (текущие mail_id, баланс, очередь и т.д.) **без уведомлений**. Со второго тика — сравнивает с baseline и уведомляет только о реальных изменениях.

Для `killmails` baseline записывается только после успешного официального ESI
ответа. Каждая новая ссылка `(killmail_id, killmail_hash)` разрешается через
официальный ESI detail. Если detail недоступен, cursor не двигается и запись
будет повторена на следующем тике; EVE-KILL fallback для привязанного персонажа
не используется.

Перед продвижением cursor разрешаются все новые официальные ссылки. В тексте
уведомления показываются максимум три подробные строки и счётчик остальных, но
скрытые этим лимитом ссылки всё равно проверяются и не могут быть пропущены.

Исключение: `skills` и `pi` уведомляют сразу если очередь пуста / планета заброшена.

## Управление через чат

Юзер управляет heartbeat через естественный язык в Telegram. Модель вызывает tool `heartbeat_config`.

```
"Включи проверку почты"          → enable_check(mail) + enable
"Включи все проверки"            → enable + enable_check × 9
"Проверяй каждые 2 часа"        → set_interval(7200)
"Выключи уведомления о кошельке" → disable_check(wallet)
"Что у меня включено?"           → list
"Выключи всё"                    → disable
```

### Tool: `heartbeat_config`

```json
{
  "name": "heartbeat_config",
  "parameters": {
    "action": "enable | disable | set_interval | enable_check | disable_check | list",
    "interval_seconds": 3600,
    "check": "mail | skills | wallet | industry | contracts | killmails | orders | notifications | pi"
  }
}
```

## Формат уведомлений

Все findings за один тик собираются в один промпт и прогоняются через модель (`runModelText`). Модель формирует краткую сводку на русском языке для текущего чата:

```
Артемий Аэле: 3 события

Почта: 1 новое от ArtyH — тестовое, действий не требуется.
Скиллы: очередь пуста — срочно поставить новые.
PI: планета в Malukker заброшена 51519ч, перезапустить экстракторы.
```

Если ничего нового — сообщение не отправляется (HEARTBEAT_OK).

Если findings есть, изменённый state и `last_run_at` коммитятся только после
успешного awaited `deliverOutbound`. Ошибка платформы оставляет предыдущий
cursor, поэтому уведомление повторяется на следующем due-тике вместо тихой
потери.

## Capability guard

ESI требует свежий `get_eve_capabilities` snapshot для приватных вызовов. Heartbeat вызывает `getEveCapabilities(db, 'heartbeat', ctx)` перед чеками, чтобы обойти этот guard.

## Graceful shutdown

`stopHeartbeat()` вызывается в `app.ts` при SIGINT/SIGTERM — останавливает cron job, не оставляет orphan-таймеров.
