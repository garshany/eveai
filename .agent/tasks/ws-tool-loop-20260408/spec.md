# WS Tool Loop Regression Fix

## Context

`eveai` started treating valid WS tool-call turns as empty responses after the proxy switched to the Responses API WebSocket transport.

## Acceptance Criteria

- AC1: `native-responses.ts` must reconstruct tool-call output from streamed Responses API events when `response.completed.output` is empty.
- AC2: unit tests must cover the streamed function-call event shape and the empty `response.completed.output` case.
- AC3: production backend must be redeployed with the fix and restart cleanly.
- AC4: live verification must show function calls are recognized again by `createNativeResponse()`.
