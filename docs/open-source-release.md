# Open-Source Release Playbook

Status: active

## Do Not Publish The Existing Git History

This working repository previously contained private deployment details and credentials in commits and local artifacts. Do not make the existing repository public by changing visibility.

Safe release options:

1. Create a clean export with no `.git` history and initialize a new public repository from that export.
2. Or rewrite history with a dedicated history-rewrite tool, verify the rewritten history, and force-push only after all exposed credentials are rotated.

The clean export option is simpler and safer for a first public release.

## Credential Rotation

Before publishing, rotate any credential that appeared in:

- git commits or deleted files
- chat logs
- screenshots
- CI logs
- `.env` files
- private deployment runbooks

At minimum, rotate model-provider tokens, Telegram bot tokens, EVE SSO client secrets, SSH keys/passwords, dashboard/session secrets, and any proxy credentials that were ever disclosed.

## Clean Export

From the repository root:

```bash
./scripts/export-public.sh ../eveai-public-export
cd ../eveai-public-export
rg -n "<old-ip>|<old-ssh-user>|<old-domain>|<old-password-fragment>|OPENAI_API_KEY=.+|TELEGRAM_BOT_TOKEN=.+|EVE_CLIENT_SECRET=." -S .
npm install
npm run check
git init
git add .
git commit -m "Initial public release"
```

The `rg` command should return no private host, domain, credential, or deployment matches.

## Public Surface Rules

- Public docs describe self-hosting only.
- Real server addresses, usernames, paths, logs, certificates, and private domains stay outside the repo.
- `.env`, `.env.*`, `data/`, `.agent/`, `.claude/`, local hooks, logs, and DB files stay ignored.
- Deployment examples must be generic and use placeholders.
- Model-provider compatibility must be documented through environment variables, not private proxy instructions.
