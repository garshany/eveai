# Perimeter navigator chat

The panel keeps the existing `PerimeterChat` props and uses `perimeter-chat.css`
with `pchat-` classes. Pilot questions, navigator answers and advisory severity
have separate visual treatments. Bodies use `MarkdownMessage`, including safe
links, code and horizontally scrollable tables. The composer owns its draft;
the memoized transcript does not render again for each keystroke or map update.
Unchanged history snapshots retain array/row identities. History returns the
latest 50 persisted messages; the live panel retains at most 100. Older messages
remain in the conversation archive. New content follows the scroll only within
48px of the bottom; readers above can use the “latest messages” button.

`POST /api/web/map/chat/reset` creates a new conversation. The active conversation
is selected by insertion order (`agent_threads.rowid`), independently of mutable
`updated_at` or second-resolution timestamp ties. Existing map streams move to
the new thread and emit `chat-reset`; the client clears the replay buffer and
refreshes history. Advisory frames carry their thread ID. Detached model
assessments for a superseded thread are discarded; already running question
requests may finish in the archived conversation. The reset does not delete the
archive or cancel unrelated conversations. Client generations/read tickets
exclude stale HTTP responses, old request events and old replay buffers.

The navigator and main chat share `AgentRequestObserver` / `agent-request-observer.ts`
and the existing `/api/web/chat/requests/:id/events` `request`/`delta` protocol.
Polling is a fallback after stream failure or 15 seconds without application
frames; requests never overlap and are aborted on cleanup. The navigator shows
queue/thinking/writing state and elapsed UTC time, recovers active requests on
reload and uses the shared idempotency helpers for ambiguous submissions.
HTTP calls have 15-second transport deadlines. After eight minutes a visible
message explains that the server is still being followed; clearing starts a new
conversation. Failed/cancelled requests and history/reset failures remain visible.

Regression coverage is in `perimeter-chat-reset.test.ts`,
`perimeter-chat-state.test.ts` and `perimeter-request-observer.test.ts`.
