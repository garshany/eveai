# Frontend

## Surface

The browser surface is intentionally small:

- landing page for product positioning and login entry
- authenticated dashboard for character visibility and switching

## Current Implementation

- Server shell: `src/web/frontend.ts`
- Browser app: `client/src/app.tsx`
- Bootstrap: `client/src/main.tsx`
- Styling: `client/src/styles.css`

## UX Rules

- The landing page is marketing plus auth entry, not a full application shell.
- The dashboard is account management, not a second primary interface.
- Telegram remains the main interaction surface for the agent.
- The landing page may use a stronger EVE-specific visual direction when product positioning changes intentionally, but it should still read as support infrastructure for Telegram-first usage rather than a separate web product.

## Security and Delivery

- HTML is server-rendered as a shell with a built Vite asset manifest.
- CSP forbids inline script execution.
- Built assets are served from `/client/*`.
