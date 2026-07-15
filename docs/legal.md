# Legal And CCP Notices

EVE Online and all related logos, images, and trademarks are the property of CCP hf. EVE AI Agent is a third-party tool and is not affiliated with, endorsed by, or supported by CCP Games.

The MIT license applies only to this project's original source code. It does not grant rights to CCP marks or game data. Preserve the following CCP proprietary notice wherever EVE or Licensed Materials are used or displayed:

> © 2014 CCP hf. All rights reserved. "EVE", "EVE Online", "CCP", and all related logos and images are trademarks or registered trademarks of CCP hf.

## EVE Developer License Agreement

This project uses EVE Online SSO, ESI, SDE, and related game data. Those materials are subject to CCP's EVE Online Developer License Agreement:

- <https://developers.eveonline.com/license-agreement>

Each operator who creates an EVE Developer application and runs a self-hosted instance is responsible for accepting and complying with that agreement.

For hosted/public instances, the application presents the versioned bilingual
player disclosure documented in [eve-sso-consent.md](./eve-sso-consent.md)
before every EVE SSO authorization. The player must acknowledge the disclosure
but may decline any or all private ESI groups. This implements least-privilege
scope selection before CCP asks the player to approve the resulting exact set.

## Community Showcase

CCP's community documentation explains how to submit public EVE community tools and services:

- <https://developers.eveonline.com/docs/community/>

As of the current community documentation, submitted services/resources must be directly related to EVE Online, comply with the Developer License Agreement, be public, be production-ready, be public for at least three months, and be actively maintained within the last year.

The current ready-to-copy page, evidence matrix, and publication gate are in [community-showcase.md](./community-showcase.md). A public repository alone does not prove production readiness or legal compliance; submit only after every current CCP requirement passes.

## Operator Responsibilities

- Configure a clear `ESI_USER_AGENT` with project and operator contact information.
- Keep EVE SSO secrets, access tokens, refresh tokens, local databases, and deployment details private.
- Do not misrepresent the project as official CCP software.
- Do not use CCP tools or game data for phishing, spam, malware, scams, unauthorized tracking, or other prohibited activity.
- Keep the consent copy aligned with the actual ESI scope mapping and configured
  AI-provider data path; a generic privacy statement is not a substitute for
  disclosing material data-flow changes.
- Re-check CCP's current terms before monetizing or submitting a hosted service.
