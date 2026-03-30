# Evidence Bundle: route-to-jita-prod-audit

## Summary
- Overall status: PASS
- Last updated: 2026-03-30T22:36:24+03:00

## Acceptance criteria evidence

### AC1
- Status: PASS
- Proof:
  - [src/telegram/handlers.ts](/home/antipedik/eveai/src/telegram/handlers.ts#L298) shows the user text entering the Telegram handler, thread resolution, message persistence, and the call into `handleAgentMessage`.
  - [src/agent/executor.ts](/home/antipedik/eveai/src/agent/executor.ts#L258) shows the route request path through `handleAgentMessage`, live-context derivation, and the final call into the native loop.
  - [src/agent/executor.ts](/home/antipedik/eveai/src/agent/executor.ts#L725) shows `plan_route` being executed, logged, and returned as structured route data plus `formatted_summary`.
  - [src/eve/route-planner.ts](/home/antipedik/eveai/src/eve/route-planner.ts#L72) shows the route planner data collection path: origin resolution, three ESI route variants, merged system info from SDE, zKill danger scan, ESI killmail enrichment, and final summary formatting.
  - [.agent/tasks/route-to-jita-prod-audit/raw/prod-route-repro.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/prod-route-repro.txt) captures a fresh prod-faithful `handleAgentMessage` repro with the exact tool path and final answer.
- Gaps:
  - None for the audited execution path.

### AC2
- Status: PASS
- Proof:
  - [.agent/tasks/route-to-jita-prod-audit/raw/prod-route-repro.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/prod-route-repro.txt) records a fresh prod repro for `Построй маршрут до Житы`, including the cold request, `plan_route` args, `danger_scan` breadth, iteration count, and final formatted response.
  - [.agent/tasks/route-to-jita-prod-audit/raw/prod-route-log-snapshot.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/prod-route-log-snapshot.txt) records the corresponding prod log pattern: 35 systems scanned, 40 zKill feed items, 29 enriched killmails, three route variants, and a two-iteration route response.
  - The captured repro proves current prod behavior before the repo-side summary fix was applied.
- Gaps:
  - No post-fix deploy/repro was performed in this task; the artifacts intentionally preserve the pre-fix prod baseline.

### AC3
- Status: PASS
- Proof:
  - [src/eve/route-planner.ts](/home/antipedik/eveai/src/eve/route-planner.ts#L173) now uses the preferred route’s own danger-system count in the top risk line instead of the merged multi-route count.
  - [src/eve/route-planner.ts](/home/antipedik/eveai/src/eve/route-planner.ts#L195) now formats the primary route with consistently emphasized system names.
  - [src/eve/route-planner.ts](/home/antipedik/eveai/src/eve/route-planner.ts#L200) keeps the Telegram-safe fixed-width comparison block and makes the danger section explicitly multi-route.
  - [tests/unit/route-planner.test.ts](/home/antipedik/eveai/tests/unit/route-planner.test.ts#L164) verifies the updated summary shape, emphasized route path, and Telegram-safe danger section text.
  - `npm run build` exited `0`; see [.agent/tasks/route-to-jita-prod-audit/raw/build.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/build.txt).
  - `npm run lint` exited `0`; see [.agent/tasks/route-to-jita-prod-audit/raw/lint.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/lint.txt).
- Gaps:
  - Telegram rendering was validated by format contract inspection, not by sending a post-fix message through the live bot.

### AC4
- Status: PASS
- Proof:
  - [src/eve/route-planner.ts](/home/antipedik/eveai/src/eve/route-planner.ts#L202) now prints every merged danger system rather than truncating to three systems.
  - [src/eve/route-planner.ts](/home/antipedik/eveai/src/eve/route-planner.ts#L205) exposes `route_flags` as visible route association in the rendered summary.
  - [src/eve/route-planner.ts](/home/antipedik/eveai/src/eve/route-planner.ts#L208) renders every enriched kill preview for each shown danger system instead of truncating to two lines.
  - [src/eve/route-planner.ts](/home/antipedik/eveai/src/eve/route-planner.ts#L211) makes remaining enrichment scope explicit when detailed kills are fewer than `kills_1h`, removing the prior silent omission.
  - [tests/unit/route-planner.test.ts](/home/antipedik/eveai/tests/unit/route-planner.test.ts#L203) verifies that preferred-route metrics remain separate from merged danger coverage and that route association is rendered.
- Gaps:
  - Detailed kill enrichment still depends on the upstream per-system cap in the current planner; the rendered summary is now explicit about that scope instead of silently implying completeness.

### AC5
- Status: PASS
- Proof:
  - `git diff --stat -- src/eve/route-planner.ts tests/unit/route-planner.test.ts` shows the implementation stayed inside two focused files with a small route-summary/test diff.
  - [src/eve/route-planner.ts](/home/antipedik/eveai/src/eve/route-planner.ts) keeps the existing `plan_route` output contract and route-planning flow while correcting only the summary/rendering layer.
  - [tests/unit/route-planner.test.ts](/home/antipedik/eveai/tests/unit/route-planner.test.ts#L133) now contains three route-planner regressions covering the updated formatting and metric separation.
  - `npm run test -- tests/unit/route-planner.test.ts` exited `0`; see [.agent/tasks/route-to-jita-prod-audit/raw/test-unit.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/test-unit.txt).
- Gaps:
  - No broader route-integration test was needed for this narrowly scoped summary change.

## Commands run
- `npm run test -- tests/unit/route-planner.test.ts`
- `npm run build`
- `npm run lint`
- prod repro command recorded in [.agent/tasks/route-to-jita-prod-audit/raw/prod-route-repro.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/prod-route-repro.txt)
- prod log snapshot command recorded in [.agent/tasks/route-to-jita-prod-audit/raw/prod-route-log-snapshot.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/prod-route-log-snapshot.txt)

## Raw artifacts
- [.agent/tasks/route-to-jita-prod-audit/raw/build.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/build.txt)
- [.agent/tasks/route-to-jita-prod-audit/raw/test-unit.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/test-unit.txt)
- [.agent/tasks/route-to-jita-prod-audit/raw/test-integration.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/test-integration.txt)
- [.agent/tasks/route-to-jita-prod-audit/raw/lint.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/lint.txt)
- [.agent/tasks/route-to-jita-prod-audit/raw/prod-route-repro.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/prod-route-repro.txt)
- [.agent/tasks/route-to-jita-prod-audit/raw/prod-route-log-snapshot.txt](/home/antipedik/eveai/.agent/tasks/route-to-jita-prod-audit/raw/prod-route-log-snapshot.txt)

## Known gaps
- The task proves the pre-fix prod baseline and the post-fix local repository state, but it does not include a post-deploy production repro.
