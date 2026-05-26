# Problems And Fixes

## P1: `apply_patch` could not update existing files

- Symptom: `apply_patch` failed with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` while updating existing files.
- Fix: used narrowly scoped scripted edits with escalated execution and checked diffs after each group.

## P2: Initial executor web-search extraction missed a constant

- Symptom: targeted `web-search-guard` tests failed because `MAX_WEB_SEARCHES_PER_TURN` was not moved to `src/agent/web-search.ts`.
- Fix: added the constant to the extracted module and reran targeted tests successfully.

## P3: Initial full check failed on lint warnings

- Symptom: `npm run check` passed typecheck/tests but failed lint due unused extraction leftovers.
- Fix: removed unused `MAX_WEB_SEARCHES_PER_TURN`, `EveKillKillmail`, `asRec`, and `numOrNull` from old modules; reran lint and full check successfully.

## P4: Runtime parity harness initially overwrote local ESI swagger cache

- Symptom: mock `fetch` returned `{}` for `https://esi.evetech.net/latest/swagger.json`, and `loadEsiCatalog` wrote that to `data/cache/esi-swagger.json`.
- Fix: restored cache from the official ESI swagger endpoint, changed harness to `NODE_ENV=test`, and pinned `ESI_CATALOG_CACHE_PATH` so catalog is read from cache instead of fetched/written.

## P5: Runtime parity harness initially failed `set_active_fit` and `plan_route`

- Symptom: `set_active_fit` used a non-supported `{user_id}` placeholder; `plan_route` failed because the broken ESI cache made route metadata unavailable.
- Fix: changed `USER_PROFILE_PATH` to supported `{chat_id}`/`{character_id}` placeholders and fixed the ESI cache issue. Runtime parity now passes 12 tool requests.
