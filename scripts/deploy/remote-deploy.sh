#!/usr/bin/env bash
# Production rollout, run ON the server by .github/workflows/deploy.yml.
#
#   remote-deploy.sh <release.tar.gz> <git-sha>
#
# Keeps the documented layout (deploy/systemd/eveai.service): the app lives in
# $EVEAI_APP_DIR with .env and data/ in place; only the build (dist/, web/dist/,
# node_modules/, package*.json) is replaced. Steps:
#   1. stage the release next to the app and `npm ci --omit=dev` there, so the
#      native better-sqlite3 build matches the server's Node;
#   2. online SQLite backup (kept: last $EVEAI_KEEP_BACKUPS);
#   3. stop the service (systemd drains in-flight answers first), swap the
#      build in, start; migrations run on startup;
#   4. wait for /health = 200; on failure, swap the previous build back,
#      restart it and exit non-zero.
# The data directory and .env are never touched. Everything is logged without
# secrets. One rollout at a time (flock).
set -euo pipefail

TARBALL="${1:?usage: remote-deploy.sh <release.tar.gz> <git-sha>}"
SHA="${2:?usage: remote-deploy.sh <release.tar.gz> <git-sha>}"
APP_DIR="${EVEAI_APP_DIR:-/srv/eveai}"
SERVICE="${EVEAI_SERVICE:-eveai}"
HEALTH_TIMEOUT="${EVEAI_HEALTH_TIMEOUT_SECONDS:-180}"
KEEP_BACKUPS="${EVEAI_KEEP_BACKUPS:-10}"
KEEP_RELEASES="${EVEAI_KEEP_RELEASES:-3}"
SYSTEMCTL="${EVEAI_SYSTEMCTL:-sudo -n systemctl}"
# The rollout lock lives on fd 9; nothing we launch may inherit it, or a
# process started here would hold the lock after this script exits.
svc() { $SYSTEMCTL "$@" 9>&-; }
BUILD_PATHS=(dist web/dist node_modules package.json package-lock.json)

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || die "invalid sha"
[[ -f "$TARBALL" ]] || die "release tarball not found: $TARBALL"
[[ -d "$APP_DIR" ]] || die "app dir not found: $APP_DIR"
[[ -f "$APP_DIR/.env" ]] || die "$APP_DIR/.env missing — configure the server first"

exec 9>"$APP_DIR/.deploy.lock"
flock -n 9 || die "another rollout is in progress"

# Health URL from the server's own .env (PORT/HOST), overridable.
env_value() { grep -E "^$1=" "$APP_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '"'"'" || true; }
PORT="$(env_value PORT)"; PORT="${PORT:-3000}"
HOST="$(env_value HOST)"; HOST="${HOST:-127.0.0.1}"
[[ "$HOST" == "0.0.0.0" || "$HOST" == "::" ]] && HOST=127.0.0.1
HEALTH_URL="${EVEAI_HEALTH_URL:-http://$HOST:$PORT/health}"
DB_PATH="$(env_value DB_PATH)"; DB_PATH="${DB_PATH:-./data/eve-agent.db}"
[[ "$DB_PATH" = /* ]] || DB_PATH="$APP_DIR/${DB_PATH#./}"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<20||(a===20&&b<19)) process.exit(1)' \
  || die "Node $(node -v) is too old; the project needs >= 20.19"

RELEASES="$APP_DIR/.releases"
STAGE="$RELEASES/$SHA"
PREVIOUS="$RELEASES/previous"
mkdir -p "$RELEASES" "$APP_DIR/data/backups"

log "staging $SHA"
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -xzf "$TARBALL" -C "$STAGE"
for path in dist web/dist package.json package-lock.json; do
  [[ -e "$STAGE/$path" ]] || die "release is missing $path"
done
(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) 9>&-
# The native SQLite binding must load under this server's Node before we stop anything.
(cd "$STAGE" && node -e "new (require('better-sqlite3'))(':memory:').close()") \
  || die "better-sqlite3 does not load in the staged release"

if [[ -f "$DB_PATH" ]]; then
  BACKUP="$APP_DIR/data/backups/$(basename "$DB_PATH" .db)-$(date -u +%Y%m%dT%H%M%SZ)-pre-$SHA.db"
  log "online SQLite backup → $(basename "$BACKUP")"
  (cd "$STAGE" && node -e "
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
    db.backup(process.argv[2]).then(() => db.close()).catch((e) => { console.error(e.message); process.exit(1); });
  " "$DB_PATH" "$BACKUP")
  ls -1t "$APP_DIR"/data/backups/*-pre-*.db 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
else
  log "no database at $DB_PATH yet — first rollout, nothing to back up"
fi

# Fingerprint of the database schema (sqlite_master), read with the staged
# release's own better-sqlite3. Empty when there is no database.
schema_fingerprint() {
  [[ -f "$DB_PATH" ]] || { echo ""; return 0; }
  (cd "$STAGE" && node -e "
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
    const rows = db.prepare(\"SELECT type, name, sql FROM sqlite_master ORDER BY type, name\").all();
    db.close();
    process.stdout.write(require('crypto').createHash('sha256').update(JSON.stringify(rows)).digest('hex'));
  " "$DB_PATH") 9>&-
}

swap_in() { # $1 = source dir holding the build to put into APP_DIR
  for path in "${BUILD_PATHS[@]}"; do
    if [[ -e "$1/$path" ]]; then
      mkdir -p "$(dirname "$APP_DIR/$path")"
      rm -rf "$APP_DIR/$path"
      mv "$1/$path" "$APP_DIR/$path"
    fi
  done
}

save_current() { # moves the running build aside into $PREVIOUS
  rm -rf "$PREVIOUS"; mkdir -p "$PREVIOUS/web"
  for path in "${BUILD_PATHS[@]}"; do
    [[ -e "$APP_DIR/$path" ]] && mv "$APP_DIR/$path" "$PREVIOUS/$path"
  done
  return 0
}

wait_healthy() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT )) code
  while (( $(date +%s) < deadline )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || true)"
    [[ "$code" == "200" ]] && return 0
    svc is-active --quiet "$SERVICE" || { log "service is not active"; return 1; }
    sleep 3
  done
  log "health did not reach 200 within ${HEALTH_TIMEOUT}s (last: ${code:-none})"
  return 1
}

PREVIOUS_SHA="$(cat "$APP_DIR/.deployed-sha" 2>/dev/null || true)"
SCHEMA_BEFORE="$(schema_fingerprint)"
log "stopping $SERVICE (drains in-flight answers)"
svc stop "$SERVICE"
save_current
swap_in "$STAGE"
echo "$SHA" > "$APP_DIR/.deployed-sha"
log "starting $SERVICE on $SHA"
svc start "$SERVICE"

if wait_healthy; then
  log "healthy at $HEALTH_URL — rollout of $SHA complete"
  # Keep a few staged releases for forensics; drop the rest.
  ls -1dt "$RELEASES"/*/ 2>/dev/null | grep -v '/previous/$' | tail -n +"$((KEEP_RELEASES + 1))" | xargs -r rm -rf
  exit 0
fi

log "ROLLING BACK to the previous build"
svc stop "$SERVICE" || true
FAILED="$RELEASES/failed-$SHA"; rm -rf "$FAILED"; mkdir -p "$FAILED/web"
for path in "${BUILD_PATHS[@]}"; do
  [[ -e "$APP_DIR/$path" ]] && mv "$APP_DIR/$path" "$FAILED/$path"
done
swap_in "$PREVIOUS"
# Old code after a new schema is the one rollback that can make things worse
# (some migrations rebuild tables). If the failed build changed the schema,
# put back the pre-rollout backup: the failed build never became healthy, so
# at most its few seconds of writes are lost.
if [[ -n "${BACKUP:-}" && "$(schema_fingerprint)" != "$SCHEMA_BEFORE" ]]; then
  log "schema changed by the failed build — restoring the pre-rollout database backup"
  rm -f "$DB_PATH-wal" "$DB_PATH-shm"
  # Overwrite in place: keeps the service account's ownership of the file.
  cat "$BACKUP" > "$DB_PATH"
fi
if [[ -n "$PREVIOUS_SHA" ]]; then echo "$PREVIOUS_SHA" > "$APP_DIR/.deployed-sha"; else rm -f "$APP_DIR/.deployed-sha"; fi
svc start "$SERVICE"
if wait_healthy; then
  log "previous build is back and healthy; $SHA was NOT deployed (see: journalctl -u $SERVICE)"
else
  log "previous build did not come back healthy either — manual attention needed; DB backup: ${BACKUP:-none}"
fi
exit 1
