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
- `/version`
- `/update`
- `/clear`
- `/reset`

## Behavior

- group chats are rejected
- access can be constrained by allowlist
- repeated identical in-flight requests are deduped per chat/thread
- `/clear` and `/reset` clear conversation state
- `/eve_login` creates a one-time EVE SSO browser link; character state stays in the chat lane
- `/version` and `/update` perform the same cached read-only stable-release check and never apply an update
