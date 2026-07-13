# Identity and Linking

## Identity Model

- Telegram and Discord identities each resolve to an internal `user_id`
- the CLI uses a dedicated local user/chat lane
- linked EVE characters are owned through `eve_character_links`
- active character state can exist on both user and chat compatibility paths

## Linking Flow

1. A Telegram, Discord, or CLI user requests EVE login.
2. The runtime creates a one-time EVE SSO state bound to the internal user and originating chat lane.
3. The user completes EVE SSO in a browser.
4. The callback stores encrypted tokens in `eve_accounts`.
5. The character is linked back to the same user and originating chat when present.
6. Active character state is updated for later agent calls.
