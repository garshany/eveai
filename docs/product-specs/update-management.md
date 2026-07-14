# Project Update Management

## Chat UX

CLI, Telegram, and Discord expose `/version` and `/update` aliases. Each reports
the installed package version and whether the latest stable canonical GitHub
release is current, newer, older than the installation, or temporarily
unavailable. `npm run update:check` exposes the same read-only check to an
operator shell.

The checker uses only
`https://api.github.com/repos/garshany/eveai/releases/latest`, accepts an exact
stable semantic version and canonical release URL, ignores release body text,
and shares one bounded 15-minute cache across chat requests.

## Authority boundary

No chat command, model tool, HTTP route, or running CLI command applies an
update. Installation changes executable code, dependencies, migrations, and
process lifecycle; those actions belong to the local operator and supervisor.
See [deployment.md](../deployment.md#updating) for the staged workflow.
