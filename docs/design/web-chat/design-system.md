# EVE AI web chat design system

The accepted concepts are [login-concept.png](./login-concept.png) and
[chat-concept.png](./chat-concept.png). They define one restrained editorial
science-fiction product surface, not a marketing site or game HUD.

## Component inventory

- App shell: quiet top bar on login; fixed conversation rail plus open chat canvas after sign-in.
- Brand: original compass/star SVG mark and the code-native `EVE AI` wordmark.
- Login: headline, one primary SSO action, one guest action, trust note, two footer links.
- Chat rail: new-chat action, selected/hover conversation rows, character/session footer, mobile drawer.
- Chat canvas: header, empty-state title, three suggestion actions, message groups, expandable execution trace, composer, runtime status.
- Feedback: accessible focus rings, loading indicator, inline sanitized error, success connection dot.

## Responsive behavior

- Desktop (`>= 960px`): persistent 332px rail and open chat canvas.
- Tablet/mobile: rail becomes an overlay drawer; top-bar menu opens it; composer remains sticky and suggestions stack vertically.
- The login split becomes a single readable content column over the generated orbital background while preserving contrast.

## Asset treatment

`orbit-route.png` is a generated background with no overlay baked into the
image. CSS may use an edge mask or a matching background fade to preserve text
contrast, but must not tint or wash the asset. `alyx-voss-concept.png` remains
an extraction reference only: production identity uses the authenticated
character name and never presents the fictional concept pilot as a real user.
