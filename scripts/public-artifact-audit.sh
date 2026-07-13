#!/usr/bin/env bash
set -euo pipefail

set +e
tracked_paths=$(git ls-files)
tracked_paths_status=$?
set -e

if [[ $tracked_paths_status -ne 0 ]]; then
  printf 'Public artifact audit failed: could not list tracked files.\n' >&2
  exit "$tracked_paths_status"
fi

blocked=()
while IFS= read -r path; do
  case "$path" in
    .env|.env.*|*/.env|*/.env.*)
      [[ "$path" == '.env.example' || "$path" == */.env.example ]] || blocked+=("$path")
      ;;
    data/*|*/data/*|logs/*|*/logs/*|.agent/*|*/.agent/*|.agents/*|*/.agents/*|.claude/*|*/.claude/*|*.log|*.log.*|*.db|*.db-*|*.sqlite|*.sqlite-*|*.sqlite3|*.sqlite3-*|*.pem|*.key|*/id_rsa|*/id_ed25519)
      blocked+=("$path")
      ;;
  esac
done <<< "$tracked_paths"

if ((${#blocked[@]} > 0)); then
  printf 'Public artifact audit failed: prohibited tracked files:\n' >&2
  printf '  %s\n' "${blocked[@]}" >&2
  exit 1
fi

set +e
matches=$(git grep -nI -E -e '-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}')
grep_status=$?
set -e

if [[ $grep_status -eq 0 ]]; then
  printf '%s\n' "$matches" >&2
  printf 'Public artifact audit failed: credential-like content found. Remove it and rotate the credential.\n' >&2
  exit 1
fi

if [[ $grep_status -ne 1 ]]; then
  printf 'Public artifact audit failed: credential scan could not run.\n' >&2
  exit "$grep_status"
fi

printf 'Public artifact audit passed.\n'
