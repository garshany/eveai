# Open-Source Release Playbook

Status: active

## Public Repository Boundary

The canonical repository is already public. Before making a new fork or mirror public, verify that its own current tree and reachable history contain no private deployment details or credentials. If a private source repository ever contained sensitive material, create a clean export or rewrite and verify its history before publishing it.

## Credential Rotation

Before publishing, rotate any credential that appeared in:

- git commits or deleted files
- chat logs
- screenshots
- CI logs
- `.env` files
- private deployment runbooks

At minimum, rotate model-provider tokens, Telegram and Discord bot tokens, EVE SSO client secrets, SSH keys/passwords, auth secrets, and any proxy credentials that were ever disclosed.

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
