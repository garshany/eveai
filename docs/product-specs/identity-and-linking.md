# Identity and Linking

## Identity Model

- Telegram identity resolves to an internal `user_id`
- web auth creates a session tied to the same `user_id`
- linked EVE characters are owned through `eve_character_links`
- active character state can exist on both user and chat compatibility paths

## Linking Flow

1. Telegram user authenticates through Telegram web login or bot-initiated flow.
2. User starts EVE SSO.
3. Callback stores encrypted tokens in `eve_accounts`.
4. Character is linked back to the same user and optionally the originating chat.
5. Active character is updated for later agent calls.
