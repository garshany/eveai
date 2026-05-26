# Product Sense

## Product

EVE Agent is a multi-user EVE Online assistant with Telegram as the primary interface, EVE SSO for private data, local SDE for static knowledge, and a lightweight web surface for login and character management.

## Primary User Jobs

- ask EVE questions in natural language without memorizing endpoints or IDs
- access private character data after explicit login
- plan routes, inspect market context, and understand risk
- manage multiple linked characters while keeping user state isolated

## Product Boundaries

- Telegram is the main UI
- web is support infrastructure, not a separate product
- live private data comes from ESI
- static reference data comes from local SDE
- the model must not own auth, retries, rate limiting, or transport internals

## What We Explicitly Avoid

- Telegram webhooks
- separate worker systems
- shell access from model-facing code
- image workflows
- external state stores such as Redis or Postgres
