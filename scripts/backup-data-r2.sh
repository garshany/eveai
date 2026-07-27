#!/usr/bin/env bash
# backup-data-r2.sh — consistent backup of the eveai data directory to Cloudflare R2.
#
# Target host: the Debian 12 VM running eveai.service (see docs/deployment.md).
# Requires: sqlite3, tar, rclone. No npm dependencies.
#
# The app keeps SQLite in WAL mode. `sqlite3 .backup` uses the SQLite online
# backup API, so the database is copied consistently WITHOUT stopping the
# service; the live DB, WAL, SHM, and the runtime lock are excluded from the
# file-level copy. Stopping eveai for a plain `tar` of data/ is not needed and
# is not what this script does.
#
# Required environment (never hardcode values here):
#   R2_ACCOUNT_ID          Cloudflare account id (from the R2 dashboard)
#   R2_ACCESS_KEY_ID       R2 API token access key (Object Read & Write, this bucket)
#   R2_SECRET_ACCESS_KEY   R2 API token secret key
#   R2_BUCKET              target bucket name
#
# Optional environment:
#   DATA_DIR         data directory                 (default: /srv/eveai/data)
#   DB_NAME          SQLite database file name      (default: eve-agent.db)
#   R2_PREFIX        key prefix inside the bucket   (default: backups)
#   RETENTION_DAYS   delete remote objects older than N days, 0 disables pruning
#                    (default: 14; a bucket lifecycle rule can replace this)
#   INCLUDE_SDE      also back up the SDE tree (~650 MB, re-downloadable via
#                    `npm run setup`)               (default: false)
#
# Remote layout: <prefix>/<YYYY>/<MM>/eveai-data-<UTC timestamp>.tar.gz

set -euo pipefail

log() { printf '[backup-data-r2] %s\n' "$*"; }
die() { printf '[backup-data-r2] ERROR: %s\n' "$*" >&2; exit 1; }

for var in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  [[ -n "${!var:-}" ]] || die "missing required environment variable $var"
done

DATA_DIR=${DATA_DIR:-/srv/eveai/data}
DB_NAME=${DB_NAME:-eve-agent.db}
R2_PREFIX=${R2_PREFIX:-backups}
RETENTION_DAYS=${RETENTION_DAYS:-14}
INCLUDE_SDE=${INCLUDE_SDE:-false}

[[ $DB_NAME != */* ]] || die "DB_NAME must be a file name, not a path: $DB_NAME"
[[ $RETENTION_DAYS =~ ^[0-9]+$ ]] || die "RETENTION_DAYS must be a non-negative integer: $RETENTION_DAYS"
case $INCLUDE_SDE in
  true|false) ;;
  *) die "INCLUDE_SDE must be 'true' or 'false': $INCLUDE_SDE" ;;
esac

DB_PATH=$DATA_DIR/$DB_NAME
[[ -d $DATA_DIR ]] || die "data directory not found: $DATA_DIR"
[[ -f $DB_PATH ]] || die "database not found: $DB_PATH"

command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not found; install with: apt-get install -y sqlite3"
command -v tar >/dev/null 2>&1 || die "tar not found; install with: apt-get install -y tar"
command -v rclone >/dev/null 2>&1 || die "rclone not found; install with: curl -fsSL https://rclone.org/install.sh | bash"

# rclone remote configured purely from the environment; the secret never
# appears in argv, a config file, or the process list.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_ACL=private

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
date_prefix=$(date -u +%Y/%m)
archive_name="eveai-data-${timestamp}.tar.gz"
remote_dir="r2:${R2_BUCKET}/${R2_PREFIX}/${date_prefix}"
remote_file="${remote_dir}/${archive_name}"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
staging=$workdir/staging
install -d -m 0700 "$staging/data"

log "creating consistent online backup of $DB_PATH (service keeps running)"
sqlite3 "$DB_PATH" ".backup '$staging/data/$DB_NAME'"

integrity=$(sqlite3 "$staging/data/$DB_NAME" 'PRAGMA integrity_check;')
[[ $integrity == ok ]] || die "integrity_check on the backup copy failed: $integrity"
# The backup copy inherits WAL mode, so the integrity check above leaves empty
# -wal/-shm sidecars in staging; they must not end up in the archive.
rm -f -- "$staging/data/$DB_NAME-wal" "$staging/data/$DB_NAME-shm"

exclude_args=(
  "--exclude=./$DB_NAME"
  "--exclude=./$DB_NAME-wal"
  "--exclude=./$DB_NAME-shm"
  "--exclude=./*.runtime.lock"
)
if [[ $INCLUDE_SDE == false ]]; then
  exclude_args+=("--exclude=./sde")
  log "excluding sde/ (re-downloadable via npm run setup; INCLUDE_SDE=true to include)"
fi

log "copying the rest of $DATA_DIR"
# GNU tar: --warning=no-file-changed keeps a concurrent profile write from
# failing the copy (exit code 1); bsdtar does not support it, so detect first.
tar_warning_args=()
if tar --warning=no-file-changed -cf /dev/null -T /dev/null 2>/dev/null; then
  tar_warning_args=(--warning=no-file-changed)
fi
tar -C "$DATA_DIR" ${tar_warning_args[@]+"${tar_warning_args[@]}"} "${exclude_args[@]}" -cf - . \
  | tar -C "$staging/data" -xf -

archive=$workdir/$archive_name
tar -C "$staging" -czf "$archive" data
archive_size=$(du -h "$archive" | cut -f1)
log "archive ready: $archive_name ($archive_size)"

log "uploading to $remote_file"
rclone copyto "$archive" "$remote_file"

# Verify the object landed before pruning anything.
if ! rclone lsf "$remote_dir" --files-only | grep -qx "$archive_name"; then
  die "upload verification failed: $archive_name not listed in $remote_dir"
fi

if [[ $RETENTION_DAYS -gt 0 ]]; then
  log "pruning remote objects older than $RETENTION_DAYS days under r2:$R2_BUCKET/$R2_PREFIX"
  rclone delete "r2:$R2_BUCKET/$R2_PREFIX" --min-age "${RETENTION_DAYS}d"
  rclone rmdirs "r2:$R2_BUCKET/$R2_PREFIX"
else
  log "retention pruning disabled (RETENTION_DAYS=0); use a bucket lifecycle rule instead"
fi

log "done: $remote_file ($archive_size)"
