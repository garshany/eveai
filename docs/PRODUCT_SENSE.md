# Product Sense

## Product

EVE Agent is a multi-user EVE Online assistant with a browser chat, Telegram,
Discord, and CLI adapters, EVE SSO for private data, and local SDE for static
knowledge.

## Primary User Jobs

- ask EVE questions in natural language without memorizing endpoints or IDs
- access private character data after explicit login
- plan routes, inspect market context, and understand risk
- manage multiple linked characters while keeping user state isolated

## Product Boundaries

- browser chat and Telegram are first-class conversation surfaces
- all surfaces share one backend agent and operator-selected model provider
- live private data comes from ESI
- static reference data comes from local SDE
- the model must not own auth, retries, rate limiting, or transport internals

## What We Explicitly Avoid

- Telegram webhooks
- separate worker systems
- shell access from model-facing code
- image workflows
- external state stores such as Redis or Postgres
