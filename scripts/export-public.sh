#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:-../eveai-public-export}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$out_dir" in
  ""|"/"|".")
    echo "Refusing unsafe output path: $out_dir" >&2
    exit 1
    ;;
esac

rm -rf "$out_dir"
mkdir -p "$out_dir"

rsync -a --delete \
  --exclude='.git/' \
  --include='.env.example' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='data/' \
  --exclude='.agent/' \
  --exclude='.agents/' \
  --exclude='.claude/' \
  --exclude='hooks/' \
  --exclude='output/' \
  --exclude='*.log' \
  --exclude='*.db' \
  --exclude='*.db-*' \
  "$repo_root/" "$out_dir/"

cat <<EOF
Public export written to: $out_dir

Next steps:
1. Inspect the export.
2. Run a secret scan over the export.
3. Initialize a new git repository inside the export.
4. Push that new repository publicly only after rotating exposed credentials.
EOF
