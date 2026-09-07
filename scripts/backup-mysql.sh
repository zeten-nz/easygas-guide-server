#!/usr/bin/env bash
#
# EASY GAS — MySQL logical backup (Phase 10F artifact)
# ====================================================
#
# SAFE, NON-DESTRUCTIVE. Produces a compressed, consistent logical dump of the
# application database. It READS only. It never touches production data beyond
# an InnoDB-consistent snapshot read, and never prints the DB password.
#
# Reads its configuration from the ENVIRONMENT (same vars as the app):
#     DB_HOST      (default 127.0.0.1)
#     DB_PORT      (default 3306)
#     DB_USER      (required)
#     DB_PASSWORD  (may be empty)
#     DB_NAME      (required — refuses to run if empty)
#     BACKUP_DIR   (required — where to write the dump)
#
# Password handling: the password is written to a temporary
# --defaults-extra-file with 0600 perms and removed by a trap on exit. It is
# NEVER passed on the command line (would show in `ps`) and NEVER echoed.
#
# Output: one gzipped dump named  <DB_NAME>-YYYYmmdd-HHMMSS.sql.gz  under
# BACKUP_DIR. On success it prints ONLY the output filename and its size.
#
# RPO implication: this is a point-in-time snapshot. Any data written AFTER the
# dump starts is NOT in this backup. Your Recovery Point Objective (RPO) is
# therefore at most the interval between backups (e.g. nightly => up to ~24h of
# data could be lost on a total-loss restore). To tighten RPO, back up more
# often and/or enable MySQL binary logs for point-in-time recovery (PITR).
# See docs/BACKUP-RESTORE-10F.md.
#
# Usage:
#     DB_USER=... DB_PASSWORD=... DB_NAME=easygas BACKUP_DIR=/var/backups/easygas/mysql \
#         bash scripts/backup-mysql.sh
#
set -euo pipefail

# --- Resolve configuration --------------------------------------------------
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_NAME="${DB_NAME:-}"
BACKUP_DIR="${BACKUP_DIR:-}"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v mysqldump >/dev/null 2>&1 || die "mysqldump not found on PATH"
command -v gzip >/dev/null 2>&1 || die "gzip not found on PATH"

# Fail closed on missing required inputs.
[ -n "$DB_NAME" ]    || die "DB_NAME is empty — refusing to run."
[ -n "$DB_USER" ]    || die "DB_USER is empty — refusing to run."
[ -n "$BACKUP_DIR" ] || die "BACKUP_DIR is empty — set where to write the dump."

mkdir -p "$BACKUP_DIR" || die "Cannot create BACKUP_DIR: $BACKUP_DIR"

# --- Secret handling: temp defaults-extra-file (0600), removed on exit -------
DEFAULTS_FILE="$(mktemp "${TMPDIR:-/tmp}/easygas-mysql-XXXXXX.cnf")"
cleanup() { rm -f "$DEFAULTS_FILE"; }
trap cleanup EXIT INT TERM
chmod 600 "$DEFAULTS_FILE"
# The [client] section is read by mysqldump. Password stays out of argv/ps.
{
  echo "[client]"
  echo "user=${DB_USER}"
  echo "password=${DB_PASSWORD}"
  echo "host=${DB_HOST}"
  echo "port=${DB_PORT}"
} > "$DEFAULTS_FILE"

# --- Run the dump -----------------------------------------------------------
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="${BACKUP_DIR}/${DB_NAME}-${TIMESTAMP}.sql.gz"

# --single-transaction : InnoDB-consistent snapshot without locking writers.
# --routines --triggers: include stored routines and triggers.
# --set-gtid-purged=OFF: don't bake GTID state into the dump (portable restore).
# --defaults-extra-file MUST be the first argument.
set +e
mysqldump \
  --defaults-extra-file="$DEFAULTS_FILE" \
  --single-transaction \
  --routines \
  --triggers \
  --set-gtid-purged=OFF \
  "$DB_NAME" | gzip -c > "$OUT_FILE"
STATUS=${PIPESTATUS[0]}
set -e

if [ "$STATUS" -ne 0 ]; then
  rm -f "$OUT_FILE"
  die "mysqldump failed (exit $STATUS). No backup written."
fi

# --- Report (filename + size ONLY; never secrets) ---------------------------
SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "Backup OK: $OUT_FILE ($SIZE)"

# ---------------------------------------------------------------------------
# HARDENING TO DO OUTSIDE THIS SCRIPT (comments only):
#   * ENCRYPT AT REST: pipe/encrypt the dump with gpg before it lands on disk,
#     e.g.  ... | gzip -c | gpg --encrypt --recipient <KEYID> > "$OUT_FILE.gpg"
#     Keep the key OFF this server.
#   * COPY OFF-SERVER: replicate the dump to off-site storage (a bucket with
#     versioning, or another host). A backup on the same box as the DB does not
#     survive a host loss.
#   * Take this DB backup and the EVIDENCE backup (backup-evidence.sh) as a
#     CONSISTENT PAIR — the DB references objects that must also exist.
#   * PRUNE old backups on a retention schedule (and verify restores!).
# ---------------------------------------------------------------------------
