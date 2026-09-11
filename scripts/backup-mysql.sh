#!/usr/bin/env bash
#
# EASY GAS — MySQL logical backup
# ===============================
#
# SAFE, NON-DESTRUCTIVE. Produces a compressed, consistent, integrity-checked
# logical dump of ONE application database. It READS only (an InnoDB-consistent
# snapshot) and never prints the DB password.
#
# Reads its configuration from the ENVIRONMENT (same vars as the app). For cron,
# load them from the env file with a SAFE loader (never `source` a dotenv file —
# a value with shell metacharacters would be executed):
#     node scripts/with-env.mjs bash scripts/backup-mysql.sh
# (see deploy/crontab.example).
#
#     DB_HOST      (default 127.0.0.1)
#     DB_PORT      (default 3306)
#     DB_USER      (required)
#     DB_PASSWORD  (may be empty)
#     DB_NAME      (required — refuses to run if empty)
#     BACKUP_DIR   (required — where to write the dump)
#     BACKUP_INCLUDE_EVENTS  (default "1" — include MySQL EVENTs; see note)
#
# Guarantees:
#   * positional SINGLE-database dump — NO --databases / --all-databases, so the
#     dump carries no CREATE DATABASE / USE (safe to restore into any target);
#   * EVERY pipeline stage is checked (mysqldump AND gzip) — a compressor or
#     disk-full failure NEVER reports success;
#   * the dump is written to a private TEMP file, integrity-verified (gzip -t)
#     and checksummed, and only then atomically published under its final name;
#   * an incomplete/corrupt artifact is removed and NO success is printed;
#   * refuses to overwrite an existing final file, and holds a lock so two runs
#     never overlap;
#   * the dump, its .sha256 and .manifest are created mode 600.
#
# Output on success (stdout): the final filename, size and sha256. A sidecar
# "<file>.sha256" (sha256sum format) and "<file>.manifest" (metadata) are written
# next to it.
#
# RPO: this is a point-in-time snapshot; data written after it starts is not in
# it. RPO/retention are a BUSINESS DECISION (see docs/BACKUP-RESTORE-10F.md) —
# this script does not assume one.
#
set -euo pipefail

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_NAME="${DB_NAME:-}"
BACKUP_DIR="${BACKUP_DIR:-}"
BACKUP_INCLUDE_EVENTS="${BACKUP_INCLUDE_EVENTS:-1}"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v mysqldump >/dev/null 2>&1 || die "mysqldump not found on PATH"
command -v gzip      >/dev/null 2>&1 || die "gzip not found on PATH"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum not found on PATH"

[ -n "$DB_NAME" ]    || die "DB_NAME is empty — refusing to run."
[ -n "$DB_USER" ]    || die "DB_USER is empty — refusing to run."
[ -n "$BACKUP_DIR" ] || die "BACKUP_DIR is empty — set where to write the dump."
# Validate DB_NAME is a plain identifier (it is used as a positional mysqldump arg).
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_NAME '$DB_NAME' is not a plain [A-Za-z0-9_] identifier — refusing."

mkdir -p "$BACKUP_DIR" || die "Cannot create BACKUP_DIR: $BACKUP_DIR"

# --- Single-writer lock: never let two backups overlap ----------------------
# flock where available (Linux/prod); a portable mkdir lock otherwise.
LOCK_DIR="${BACKUP_DIR}/.backup.lock"
LOCKED_BY_FLOCK=0
if command -v flock >/dev/null 2>&1; then
  exec 9>"${BACKUP_DIR}/.backup.flock"
  flock -n 9 || die "another backup is already running (flock) — refusing to overlap."
  LOCKED_BY_FLOCK=1
else
  mkdir "$LOCK_DIR" 2>/dev/null || die "another backup is already running (lock dir present) — refusing to overlap."
fi

# --- Temp/secret handling; everything cleaned on ANY exit -------------------
DEFAULTS_FILE="$(mktemp "${TMPDIR:-/tmp}/easygas-mysql-XXXXXX.cnf")"
chmod 600 "$DEFAULTS_FILE"
TMP_OUT=""   # set once we know the final path
cleanup() {
  rm -f "$DEFAULTS_FILE"
  [ -n "$TMP_OUT" ] && rm -f "$TMP_OUT"
  [ "$LOCKED_BY_FLOCK" = "1" ] || rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
# The [client] section is read by mysqldump. Password stays out of argv/ps.
{
  echo "[client]"
  echo "user=${DB_USER}"
  echo "password=${DB_PASSWORD}"
  echo "host=${DB_HOST}"
  echo "port=${DB_PORT}"
} > "$DEFAULTS_FILE"

TIMESTAMP="$(date -u +%Y%m%d-%H%M%SZ)"
OUT_FILE="${BACKUP_DIR}/${DB_NAME}-${TIMESTAMP}.sql.gz"
[ -e "$OUT_FILE" ] && die "Refusing to overwrite existing backup: $OUT_FILE"
# Private temp artifact in the same dir (same filesystem → atomic rename).
TMP_OUT="$(mktemp "${BACKUP_DIR}/.${DB_NAME}-${TIMESTAMP}.XXXXXX.partial")"
chmod 600 "$TMP_OUT"

# --- Build mysqldump args ---------------------------------------------------
# --single-transaction : InnoDB-consistent snapshot without locking writers.
# --routines --triggers: include stored routines and triggers.
# --events (opt)       : include MySQL EVENTs. EasyGas schedules maintenance via
#                        EXTERNAL cron (deploy/crontab.example), not MySQL events,
#                        so there normally are none — but we include them by
#                        default so the dump is COMPLETE if any ever exist. Set
#                        BACKUP_INCLUDE_EVENTS=0 to omit (e.g. lacking the EVENT
#                        privilege).
# --no-tablespaces     : avoids needing the global PROCESS privilege (least-privilege
#                        backup user); InnoDB file-per-table needs no tablespace DDL.
# --set-gtid-purged=OFF: don't bake GTID state into the dump (portable restore).
DUMP_ARGS=(
  "--defaults-extra-file=${DEFAULTS_FILE}"
  --single-transaction
  --routines
  --triggers
  --no-tablespaces
  --set-gtid-purged=OFF
)
EVENTS_BOOL=false
if [ "$BACKUP_INCLUDE_EVENTS" = "1" ]; then DUMP_ARGS+=(--events); EVENTS_BOOL=true; fi
DUMP_ARGS+=("$DB_NAME")   # POSITIONAL single DB — never --databases/--all-databases

# --- Run the dump, checking BOTH pipeline stages ----------------------------
set +e
mysqldump "${DUMP_ARGS[@]}" | gzip -c > "$TMP_OUT"
STATUSES=("${PIPESTATUS[@]}")   # [0]=mysqldump  [1]=gzip (also catches the > write)
set -e
DUMP_STATUS="${STATUSES[0]}"
GZIP_STATUS="${STATUSES[1]:-1}"
[ "$DUMP_STATUS" -eq 0 ] || die "mysqldump failed (exit $DUMP_STATUS). No backup written."
[ "$GZIP_STATUS" -eq 0 ] || die "gzip/output-write failed (exit $GZIP_STATUS) — possibly disk full or a broken compressor. No backup written."
[ -s "$TMP_OUT" ]        || die "Dump produced an EMPTY file. No backup written."

# --- Validate the compressed artifact BEFORE publishing ---------------------
gzip -t "$TMP_OUT" || die "gzip integrity check FAILED on the fresh dump — the archive is corrupt. No backup written."
# Sanity: a valid mysqldump ends with a completion marker.
if ! gzip -dc "$TMP_OUT" | tail -c 4096 | grep -q "Dump completed on"; then
  die "Dump is missing the 'Dump completed on' marker — it is truncated/incomplete. No backup written."
fi

SHA256="$(sha256sum "$TMP_OUT" | awk '{print $1}')"

# --- Atomic publish: rename temp → final, then write sidecars ---------------
mv -n "$TMP_OUT" "$OUT_FILE" || die "Atomic publish failed (target may have appeared). No backup published."
# `mv -n` is a no-op (exit 0) if the target already exists — verify the publish
# actually happened and the temp is gone before claiming success.
[ -s "$OUT_FILE" ] || die "Publish verification failed: $OUT_FILE missing/empty after move. No backup published."
[ -e "$TMP_OUT" ] && die "Publish verification failed: temp artifact still present (target pre-existed). No backup published."
TMP_OUT=""   # published — the trap must not delete it now
chmod 600 "$OUT_FILE"

# The sha256 line must reference the FINAL basename so `sha256sum -c` works from
# BACKUP_DIR.
printf '%s  %s\n' "$SHA256" "$(basename "$OUT_FILE")" > "${OUT_FILE}.sha256"
chmod 600 "${OUT_FILE}.sha256"

SIZE_BYTES="$(wc -c < "$OUT_FILE" | tr -d ' ')"
{
  echo "{"
  echo "  \"file\": \"$(basename "$OUT_FILE")\","
  echo "  \"database\": \"${DB_NAME}\","
  echo "  \"created_utc\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"size_bytes\": ${SIZE_BYTES},"
  echo "  \"sha256\": \"${SHA256}\","
  echo "  \"mysqldump_version\": \"$(mysqldump --version 2>/dev/null | head -1 | sed 's/\"/\x27/g')\","
  echo "  \"includes\": { \"routines\": true, \"triggers\": true, \"events\": ${EVENTS_BOOL} },"
  echo "  \"single_database\": true"
  echo "}"
} > "${OUT_FILE}.manifest"
chmod 600 "${OUT_FILE}.manifest"

echo "Backup OK: ${OUT_FILE}"
echo "  size   : ${SIZE_BYTES} bytes"
echo "  sha256 : ${SHA256}"
echo "  sidecars: $(basename "$OUT_FILE").sha256, $(basename "$OUT_FILE").manifest"
