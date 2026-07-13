# EVE Community Showcase Submission

Status: blocked until public-age and operator-attestation gates pass

This is the ready-to-copy submission bundle for CCP's [Community Showcase](https://developers.eveonline.com/docs/community/). The Showcase is maintained in [`esi/esi-docs`](https://github.com/esi/esi-docs); it is not an application-form registration.

## Classification

EVE AI Agent is a **service**: an end user can use it directly by running their own Telegram or Discord bot instance. CCP classifies end-user tools, including software users install themselves, as services; developer building blocks are resources.

## Target Pull Request

1. Fork [`esi/esi-docs`](https://github.com/esi/esi-docs).
2. Add `docs/community/eve-ai-agent/index.md` with the exact content below.
3. Open a focused PR containing only this page and any compliant image assets.

The exact template requires `search.exclude: true`, `type: service`, a one-line description, and `maintainer.name` plus exactly one of `github`, `gitlab`, or `repository`. The search exclusion is mandatory. Do not add a Website, Discord, screenshots, or claims that do not have a stable public URL.

```md
---
search:
  exclude: true

title: EVE AI Agent
type: service
description: A self-hosted chat-first AI assistant for EVE Online with Telegram and Discord bots, EVE SSO, live ESI data, local SDE search, route planning, and killboard intelligence.
maintainer:
  name: garshany
  github: garshany
---

# EVE AI Agent

EVE AI Agent is a self-hosted chat-first assistant for EVE Online. Run it with Telegram or Discord, or use its terminal CLI. It uses the official EVE SSO and ESI APIs for player-authorized character data, a local SDE SQLite database for static data, and public EVE community data sources for route and combat intelligence.

<div class="grid cards" markdown>

- [:octicons-mark-github-16: __GitHub__](https://github.com/garshany/eveai){ .esi-card-link }

</div>

## Features

- Natural-language EVE assistance in Telegram private chats, Discord DMs, or a terminal CLI.
- EVE SSO character linking with encrypted local token storage and scope-aware access to private ESI data.
- Local SDE lookup for systems, items, dogma, blueprints, and routes; live ESI for authorized character, corporation, market, assets, skills, industry, mail, and location data.
- Route planning with danger analysis, killmail context, gate-camp signals, and Thera or Turnur shortcuts.
- D-scan, local and fleet analysis, zKillboard and EVE-KILL intelligence, EVE-Scout data, and opt-in chat notifications.

## Self-hosting

The project is available under the MIT license. See its GitHub README for setup, EVE Developer application configuration, and deployment guidance.
```

If images are later added, place them in that same target directory. Each must be no larger than 250 KB or 1024×768 pixels; use no more than ten unless necessary.

## Eligibility Matrix — checked 2026-07-13

| CCP requirement | Verdict | Evidence and action |
| --- | --- | --- |
| Directly related to EVE Online | PASS | The public repository describes EVE SSO, ESI, local SDE, route planning, and EVE intelligence. |
| Complies with the Developer License Agreement | NEEDS OPERATOR ATTESTATION | The project documents the agreement, non-affiliation, non-commercial boundary, and prohibited misuse. Only the responsible operator can attest that their EVE account/application and deployment comply with the agreement. |
| Public service/resource | PASS | The canonical source repository, [`garshany/eveai`](https://github.com/garshany/eveai), is publicly visible on GitHub under MIT. |
| Production-ready | NEEDS OPERATOR DEPLOYMENT ATTESTATION | The public v3.0.0 release has a reproducible install path and validation gate. A responsible operator must still attest that their own deployment is live and complies with CCP requirements before submission. |
| Public for at least three months | CONSERVATIVE FAIL UNTIL 2026-10-13 | GitHub records the repository's initial `PublicEvent` on 2026-03-24, but the source did not remain public continuously before this v3 release. Do not use that event to claim uninterrupted public availability. Use the current public-release date, 2026-07-13, as the conservative start; three full calendar months complete on 2026-10-13. |
| Actively maintained within the last year | PASS | The public default branch and immutable v3.0.0 release were updated and verified on 2026-07-13. |

## Publication Gate

Do **not** open the CCP pull request yet. Before 2026-10-13, keep the current validated code and documentation public, make the legal/operator attestation, and retain production-readiness evidence. On or after that date, repeat this matrix against the live public repository, then fork `esi/esi-docs` and submit the page above as a focused PR.
