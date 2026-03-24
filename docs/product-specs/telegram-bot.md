# Telegram Bot

## Primary Surface

Telegram private chat is the main user interface for the product.

## Commands

- `/start`
- `/help`
- `/commands`
- `/eve_login`
- `/eve-login`
- `/whoami`
- `/characters`
- `/chars`
- `/use <id|name>`
- `/market <type_id>`
- `/info <target_id>`
- `/web`
- `/clear`
- `/reset`

## Behavior

- group chats are rejected
- access can be constrained by allowlist
- repeated identical in-flight requests are deduped per chat/thread
- `/clear` and `/reset` clear conversation state
