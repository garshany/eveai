# Discord Bot

## Primary Surface

Discord is a DM-only chat adapter that shares the same agent runtime and EVE-character ownership model as Telegram. Guild-channel messages are ignored. Slash commands are registered for Discord's available interaction contexts, but a guild invocation receives an ephemeral instruction to use a DM and never reaches the agent runtime.

## Commands

- `/start`
- `/help`
- `/eve_login`
- `/whoami`
- `/characters`
- `/use <id|name>`
- `/market <type_id>`
- `/info <target_id>`
- `/version`
- `/update`
- `/clear`

## Behavior

- no privileged Discord intents are required; ordinary messages are handled in DMs only
- an optional Discord-user allowlist can restrict access
- ordinary DM text is routed to the shared agent runtime
- `/eve_login` sends a short one-time browser link for EVE SSO; the callback confirms success in the browser and tells the user to return to Discord
- `/clear` clears the conversation state for that Discord DM lane
- `/version` and `/update` are read-only; they never grant checkout, package-manager, or restart control
