# Evidence Bundle: eve-api-audit

## Summary
- Overall status: PASS
- Last updated: 2026-03-25T03:16:00+00:00

## Acceptance criteria evidence

### AC1
- Status: PASS
- Proof:
  - [src/web/auth-routes.ts](/home/antipedik/eveai/src/web/auth-routes.ts#L72) redirects to the official EVE authorization endpoint and sets `response_type=code`, `redirect_uri`, `client_id`, `scope`, and `state` before redirecting.
  - [src/web/auth-routes.ts](/home/antipedik/eveai/src/web/auth-routes.ts#L95) validates `code` and `state` before exchanging the authorization code, and marks the state as used before token exchange.
  - [src/eve/sso-auth.ts](/home/antipedik/eveai/src/eve/sso-auth.ts#L70) verifies JWT issuer, audience, and `CHARACTER:EVE:` subject shape before accepting access tokens.
  - `npm run test -- tests/unit/sso.test.ts tests/unit/auth-routes.test.ts tests/unit/capabilities.test.ts` exited `0` and exercised the callback and token-validation paths.
- Gaps:
  - None.

### AC2
- Status: PASS
- Proof:
  - [src/eve/esi-client.ts](/home/antipedik/eveai/src/eve/esi-client.ts#L202) sends `User-Agent` and `X-Compatibility-Date` on every ESI request, and binds private requests to the linked character via `resolveAccess`.
  - [src/eve/sso.ts](/home/antipedik/eveai/src/eve/sso.ts#L240) keeps refresh logic server-side and isolated from model-facing code.
  - [src/eve/esi-client.ts](/home/antipedik/eveai/src/eve/esi-client.ts#L120) keeps parameter serialization and header handling inside the client, not in model-visible surfaces.
  - `npm run test -- tests/unit/esi-client.test.ts tests/unit/sso.test.ts tests/unit/auth-routes.test.ts tests/unit/capabilities.test.ts` exited `0`.
- Gaps:
  - None.

### AC3
- Status: PASS
- Proof:
  - [src/eve/esi-client.ts](/home/antipedik/eveai/src/eve/esi-client.ts#L220) revalidates GET cache entries with `If-None-Match` / `If-Modified-Since` and accepts `304`.
  - [src/eve/esi-client.ts](/home/antipedik/eveai/src/eve/esi-client.ts#L301) retries `420`, `429`, and transient `5xx` with bounded attempts and backoff.
  - [src/eve/esi-client.ts](/home/antipedik/eveai/src/eve/esi-client.ts#L261) fails closed on `X-Pages` snapshot drift, and [src/eve/esi-client.ts](/home/antipedik/eveai/src/eve/esi-client.ts#L277) fails when configured page limits would be exceeded.
  - `npm run test -- tests/unit/esi-client.test.ts` exited `0` and now includes regression coverage for `Last-Modified` snapshot matching and snapshot drift failure.
  - [docs/RELIABILITY.md](/home/antipedik/eveai/docs/RELIABILITY.md#L7) states the documented cache, retry, and pagination expectations now reflected by the implementation.
- Gaps:
  - None.

### AC4
- Status: PASS
- Proof:
  - [src/eve/capabilities.ts](/home/antipedik/eveai/src/eve/capabilities.ts#L85) records and checks a fresh capability snapshot with a 10-minute TTL.
  - [src/eve/esi-client.ts](/home/antipedik/eveai/src/eve/esi-client.ts#L97) rejects private ESI access when the linked character is absent, the snapshot is stale, or the required scopes are missing.
  - `npm run test -- tests/unit/capabilities.test.ts tests/unit/esi-client.test.ts` exited `0`.
- Gaps:
  - None.

### AC5
- Status: PASS
- Proof:
  - [docs/RELIABILITY.md](/home/antipedik/eveai/docs/RELIABILITY.md#L7) now documents the same ESI cache and pagination model implemented in [src/eve/esi-client.ts](/home/antipedik/eveai/src/eve/esi-client.ts#L220).
  - [docs/SECURITY.md](/home/antipedik/eveai/docs/SECURITY.md#L1) still matches the runtime boundary around secrets and private ESI access.
  - [src/web/auth-routes.ts](/home/antipedik/eveai/src/web/auth-routes.ts#L72) and [src/eve/esi-client.ts](/home/antipedik/eveai/src/eve/esi-client.ts#L88) present a single consistent model for SSO, ESI transport, and private-access gating.
  - `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test -- tests/integration/auth-callback.test.ts`, and the focused unit tests all exited `0`.
- Gaps:
  - None.

## Commands run
- `npm run build`
- `npm run test -- tests/unit/esi-client.test.ts tests/unit/sso.test.ts tests/unit/auth-routes.test.ts tests/unit/capabilities.test.ts`
- `npm run test -- tests/integration/auth-callback.test.ts`
- `npm run lint`
- `npm run typecheck`

## Raw artifacts
- .agent/tasks/eve-api-audit/raw/build.txt
- .agent/tasks/eve-api-audit/raw/test-unit.txt
- .agent/tasks/eve-api-audit/raw/test-integration.txt
- .agent/tasks/eve-api-audit/raw/lint.txt
- .agent/tasks/eve-api-audit/raw/screenshot-1.png

## Known gaps
- None.
