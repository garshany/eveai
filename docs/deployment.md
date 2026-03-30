# Deployment Runbook

Этот файл описывает текущий production deployment для `garshany/eveai`.

## GitHub

Для операций с репозиторием использовать `gh`, а не ручное копирование URL, когда это возможно.

Проверка авторизации:

```bash
gh auth status
```

Клонирование:

```bash
gh repo clone garshany/eveai
cd eveai
```

Проверка remote:

```bash
git remote -v
```

Пуш в основной репозиторий:

```bash
git push origin master
```

## Server Access

Текущий production server:

- host: `144.31.223.134`
- user: `root`
- app dir: `/opt/eveai`

Подключение по SSH:

```bash
ssh root@144.31.223.134
```

Если нужен non-interactive доступ с паролем, использовать `sshpass` только в локальном trusted shell и не хардкодить пароль в репозиторий.

Пример:

```bash
sshpass -p '***' ssh -o StrictHostKeyChecking=no root@144.31.223.134
```

## Deployment Flow

`codex-proxy` на сервере считается внешним сервисом. Этот runbook не управляет его lifecycle.

Базовый деплой:

```bash
ssh root@144.31.223.134
cd /opt/eveai
git fetch origin
git checkout master
git pull --ff-only origin master
npm ci
npm run build
pm2 restart eveai --update-env
```

Если каталог ещё не создан:

```bash
gh repo clone garshany/eveai /opt/eveai
cd /opt/eveai
npm ci
npm run build
```

## Environment

Основной runtime config:

- `/opt/eveai/.env`

Важные production значения:

- `WEB_BASE_URL=https://eveonline-ai.ru`
- `EVE_CALLBACK_URL=https://eveonline-ai.ru/auth/eve/callback`
- `OPENAI_BASE_URL=http://127.0.0.1:8080/v1`
- `ESI_USER_AGENT=EVEAIBOT/1.0 (garshany80@gmail.com; +https://github.com/garshany/eveai)`
- `ZKILL_USER_AGENT=EVEAIBOT/1.0 (garshany80@gmail.com; +https://github.com/garshany/eveai)`
- `SSO_REQUEST_TIMEOUT_MS=8000`
- `ESI_REQUEST_TIMEOUT_MS=8000`
- `ESI_RETRY_MAX_ATTEMPTS=3`

После изменения `.env`:

```bash
pm2 restart eveai --update-env
```

## Process Model

Приложение:

- process manager: `pm2`
- process name: `eveai`

Проверка:

```bash
pm2 status eveai
pm2 logs eveai --lines 100
```

Reverse proxy:

- service: `nginx`
- config: `/etc/nginx/sites-available/eveai`

Проверка:

```bash
systemctl status nginx --no-pager
journalctl -u nginx -n 100 --no-pager
nginx -t
```

## URLs

HTTP:

- `http://eveonline-ai.ru` (redirect → HTTPS)

HTTPS:

- `https://eveonline-ai.ru`
- `https://eveonline-ai.ru/health`

## SSL

Сертификат выпускается для `eveonline-ai.ru` через `certbot`.

Полезные команды:

```bash
certbot certificates
certbot renew --dry-run --no-random-sleep-on-renew
openssl x509 -in /etc/letsencrypt/live/eveonline-ai.ru/fullchain.pem -noout -issuer -dates -subject
```

Deploy hook reload'ит nginx после renewal (`systemctl reload nginx`).

## Health Checks

Локально на сервере:

```bash
curl http://127.0.0.1:8000/health
curl -sk https://127.0.0.1:4443/health
```

Снаружи:

```bash
curl -I http://eveonline-ai.ru
curl -sI https://eveonline-ai.ru/health
```

Smoke:

```bash
cd /opt/eveai
npm run smoke
```

## EVE SSO

В EVE Developer Portal redirect URI должен совпадать точно:

```text
https://eveonline-ai.ru/auth/eve/callback
```

Если URI отличается, логин через EVE SSO будет отклонён до callback.

## ESI Runtime Notes

- ESI requests must continue sending both `User-Agent` and `X-Compatibility-Date`
- the app now revalidates cached GETs with `ETag` / `If-None-Match`
- the client does bounded retry for `429`, `420`, and transient `5xx`
- if an `X-Pages` endpoint requires more pages than `ESI_MAX_PAGES`, the app fails the request instead of silently truncating data
