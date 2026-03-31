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

Целевое production состояние:

- `eveai` backend управляется через `pm2`
- `codex-openai-proxy` управляется через `systemd`
- `nginx` управляется через `systemd`

Если proxy запущен отдельным root-процессом без supervisor, это drift. Его нужно вернуть под `systemd`, а не добавлять во второй process tree через `pm2`.

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

Proxy после обновления бинаря:

```bash
ssh root@144.31.223.134
cd /opt/codex_proxy
cargo build --release
systemctl restart eveai-codex-proxy
systemctl status eveai-codex-proxy --no-pager
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

## Codex Proxy

Предпочтительный supervisor для proxy: `systemd`, не `pm2`.

Почему:

- proxy является инфраструктурным dependency для backend, а не частью Node.js runtime
- `systemd` поднимает процесс после reboot без отдельной PM2 ecosystem
- `journalctl` удобнее для диагностики раннего старта и auth-проблем
- backend можно перезапускать отдельно через `pm2`, не трогая proxy

Текущий service template в репозитории:

- `deploy/systemd/eveai-codex-proxy.service`

Установка или восстановление unit на проде:

```bash
ssh root@144.31.223.134
install -m 644 /opt/eveai/deploy/systemd/eveai-codex-proxy.service /etc/systemd/system/eveai-codex-proxy.service
systemctl daemon-reload
systemctl enable --now eveai-codex-proxy
systemctl status eveai-codex-proxy --no-pager
```

Проверка:

```bash
systemctl status eveai-codex-proxy --no-pager
journalctl -u eveai-codex-proxy -n 100 --no-pager
curl -fsS http://127.0.0.1:8080/health
```

## Codex Proxy Auth Rotation

Proxy читает все `*.json` в директории auth-path. На проде активная директория:

- `/root/.codex/auth/`

Важно:

- не оставлять протухшие `*.json` в `/root/.codex/auth/`
- backup хранить вне активной директории, иначе proxy подхватит старые credentials
- в проде держать один активный auth-файл, если не нужна осознанная ротация между несколькими аккаунтами
- никогда не коммитить auth JSON или токены в репозиторий

Минимальный поддерживаемый формат auth-файла:

```json
{
  "auth_mode": "chatgpt",
  "tokens": {
    "access_token": "REDACTED",
    "account_id": "REDACTED"
  }
}
```

Порядок обновления auth:

```bash
ssh root@144.31.223.134
mkdir -p /root/.codex/auth
ts=$(date +%Y%m%dT%H%M%S)
mkdir -p /root/.codex/auth-backup-$ts
mv /root/.codex/auth/*.json /root/.codex/auth-backup-$ts/ 2>/dev/null || true
cat > /root/.codex/auth/prod-primary.json <<'JSON'
{
  "auth_mode": "chatgpt",
  "tokens": {
    "access_token": "REDACTED",
    "account_id": "REDACTED"
  }
}
JSON
chmod 600 /root/.codex/auth/prod-primary.json
systemctl restart eveai-codex-proxy
```

Проверка после rotation:

```bash
curl -fsS http://127.0.0.1:8080/health
curl -sS -N \
  -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:8080/v1/responses \
  -d '{"model":"gpt-5.4","instructions":"You are a concise assistant.","input":[{"role":"user","content":[{"type":"input_text","text":"Reply with the single word pong."}]}]}' \
  | sed -n '1,40p'
pm2 status eveai
curl -fsS http://127.0.0.1:8000/health
pm2 logs eveai --lines 50 --nostream
```

Успешный признак:

- proxy отвечает `200 OK` на `POST /v1/responses`
- stream содержит `response.completed`
- `eveai` перестаёт писать `token_expired`

## Skills Through Codex Proxy

Skills (SKILL.md bundles) work through the proxy via a function tool `"shell"`, not the official `type: "shell"` API format (rejected by ChatGPT backend).

The model calls `shell(["bash", "-lc", "cat /path/to/SKILL.md"])`, the app executes locally and returns output. Full protocol: [docs/skills-protocol.md](./skills-protocol.md).

Quick verification on prod:

```bash
curl -sS -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:8080/v1/responses \
  -d '{
    "model": "gpt-5.4",
    "instructions": "You have a skill: basic-math at /tmp/skills/basic-math. Read SKILL.md first.",
    "input": [{"role":"user","content":[{"type":"input_text","text":"Add 2+2 using the skill"}]}],
    "tools": [{"type":"function","name":"shell","description":"Run a local command.","parameters":{"type":"object","properties":{"command":{"type":"array","items":{"type":"string"}}},"required":["command"]}}],
    "store": false, "stream": false
  }'
```

Expected: `function_call` with `shell(["bash","-lc","cat /tmp/skills/basic-math/SKILL.md"])`.

## Process Model

Приложение:

- process manager: `pm2`
- process name: `eveai`

Проверка:

```bash
pm2 status eveai
pm2 logs eveai --lines 100
```

Codex proxy:

- process manager: `systemd`
- service name: `eveai-codex-proxy`
- binary dir: `/opt/codex_proxy`
- auth dir: `/root/.codex/auth/`

Проверка:

```bash
systemctl status eveai-codex-proxy --no-pager
journalctl -u eveai-codex-proxy -n 100 --no-pager
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
