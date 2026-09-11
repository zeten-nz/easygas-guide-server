#!/usr/bin/env bash
#
# EASY GAS — MySQL restore (Phase 10F artifact)  ***DESTRUCTIVE***
# ===============================================================
#
# This OVERWRITES the target database with the contents of a gzip dump produced
# by scripts/backup-mysql.sh. It is guarded HARD and DEFAULTS TO DRY-RUN.
#
# It NEVER targets production implicitly. To actually write, ALL of these must
# hold:
#   * a dump file is passed as $1 and exists,
#   * RESTORE_TARGET_DB is set (the DB to restore INTO — chosen explicitly),
#   * CONFIRM_RESTORE=yes  (typed confirmation),
#   * APPLY=1              (otherwise it only prints what it would do),
#   * and, if RESTORE_TARGET_DB does NOT end in "_test" (i.e. it looks like a
#     real/production database), FORCE_PROD_RESTORE=yes must ALSO be set.
#
# Reads DB connection config from the environment (never echoes the password;
# uses a temp --defaults-extra-file with 0600 perms, removed by a trap):
#     DB_HOST (default 127.0.0.1), DB_PORT (default 3306), DB_USER (required),
#     DB_PASSWORD (may be empty)
#
# Usage (safe dry-run — DEFAULT):
#     RESTORE_TARGET_DB=easygas_test CONFIRM_RESTORE=yes \
#       DB_USER=... DB_PASSWORD=... bash scripts/restore-mysql.sh dump.sql.gz
#
# Usage (apply to a *_test DB):
#     APPLY=1 RESTORE_TARGET_DB=easygas_test CONFIRM_RESTORE=yes \
#       DB_USER=... DB_PASSWORD=... bash scripts/restore-mysql.sh dump.sql.gz
#
# Usage (apply to a real DB — requires the extra force flag):
#     APPLY=1 FORCE_PROD_RESTORE=yes RESTORE_TARGET_DB=easygas \
#       CONFIRM_RESTORE=yes DB_USER=... DB_PASSWORD=... \
#       bash scripts/restore-mysql.sh dump.sql.gz
#
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

DUMP_FILE="${1:-}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-}"
DB_PASSWORD="${DB_PASSWORD:-}"
RESTORE_TARGET_DB="${RESTORE_TARGET_DB:-}"
CONFIRM_RESTORE="${CONFIRM_RESTORE:-}"
FORCE_PROD_RESTORE="${FORCE_PROD_RESTORE:-}"
APPLY="${APPLY:-0}"

command -v mysql >/dev/null 2>&1 || die "mysql client not found on PATH"
command -v gzip  >/dev/null 2>&1 || die "gzip not found on PATH"

# --- Input guards (fail closed) ---------------------------------------------
[ -n "$DUMP_FILE" ]         || die "No dump file given. Usage: restore-mysql.sh <dump.sql.gz>"
[ -f "$DUMP_FILE" ]         || die "Dump file not found: $DUMP_FILE"
[ -n "$DB_USER" ]           || die "DB_USER is empty — refusing."
[ -n "$RESTORE_TARGET_DB" ] || die "RESTORE_TARGET_DB is empty — set the database to restore INTO."
[ "$CONFIRM_RESTORE" = "yes" ] || die "CONFIRM_RESTORE is not 'yes' — refusing (typed confirmation required)."

# Production-shaped target requires the extra explicit force flag. Heuristic:
# anything NOT ending in "_test" is treated as potentially production.
if [[ "$RESTORE_TARGET_DB" != *_test ]]; then
  if [ "$FORCE_PROD_RESTORE" != "yes" ]; then
    die "Target '$RESTORE_TARGET_DB' does not end in '_test' (looks like production). Set FORCE_PROD_RESTORE=yes to allow. Refusing."
  fi
  echo "WARNING: restoring into a NON-test database '$RESTORE_TARGET_DB' (FORCE_PROD_RESTORE=yes)."
fi

# --- HAZARD GUARD (fail closed, best-effort heuristic — NOT a comprehensive SQL ---
# parser): reject a dump that carries its OWN database context. `mysqldump
# --databases`/`--all-databases` embed `CREATE DATABASE …` and `USE <db>;` as
# line-start statements; piped into `mysql <target>`, the `USE` lines SILENTLY
# redirect every statement to the dump's database, ignoring RESTORE_TARGET_DB and
# thereby bypassing BOTH the `_test` and FORCE_PROD_RESTORE guards above (a dump of
# a production DB would overwrite production even with RESTORE_TARGET_DB=..._test).
#
# WHAT THIS RELIABLY CATCHES: every dump the mysqldump family actually produces —
# plain `CREATE DATABASE`/`USE` at line start, leading whitespace/case variants, and
# the `/*!NNNNN … */` executable-comment wrapper (executed by real mysql). It is
# anchored at line start so quoted DATA values that merely contain the word "use"
# do not trip it.
# KNOWN LIMITS (this is a heuristic, not a proof of safety): a hand-crafted dump
# could still evade it — e.g. a `USE` mid-line after another statement, or split
# across lines. So this is DEFENSE-IN-DEPTH, not a security boundary. The actual
# guarantee is: only restore dumps produced by scripts/backup-mysql.sh, which dumps
# a SINGLE database positionally and emits no CREATE DATABASE/USE at all.
#
# grep -c (not -q): reads the WHOLE stream, so gzip never gets SIGPIPE — which under
# `set -o pipefail` would otherwise make this pipeline exit non-zero on a match and
# silently skip the guard. `|| true` absorbs grep's exit 1 on a zero count.
HAZARD_HITS="$(gzip -dc "$DUMP_FILE" 2>/dev/null \
  | grep -ciE '^[[:space:]]*(/\*![0-9]*[[:space:]]+)?(CREATE[[:space:]]+DATABASE\b|USE[[:space:]]+`?[A-Za-z0-9_$]+`?)' || true)"
if [ "${HAZARD_HITS:-0}" != "0" ]; then
  die "Dump appears to embed CREATE DATABASE / USE ($HAZARD_HITS line(s)) and would target its OWN database, ignoring RESTORE_TARGET_DB='$RESTORE_TARGET_DB' and bypassing the safety guards. Re-create it with scripts/backup-mysql.sh (single-DB, no USE) or strip those lines. Refusing."
fi

# --- Secret handling: temp defaults-extra-file (0600), removed on exit -------
DEFAULTS_FILE="$(mktemp "${TMPDIR:-/tmp}/easygas-restore-XXXXXX.cnf")"
cleanup() { rm -f "$DEFAULTS_FILE"; }
trap cleanup EXIT INT TERM
chmod 600 "$DEFAULTS_FILE"
{
  echo "[client]"
  echo "user=${DB_USER}"
  echo "password=${DB_PASSWORD}"
  echo "host=${DB_HOST}"
  echo "port=${DB_PORT}"
} > "$DEFAULTS_FILE"

# --- Dry-run vs apply -------------------------------------------------------
echo "Restore plan:"
echo "  dump file : $DUMP_FILE"
echo "  target DB : $RESTORE_TARGET_DB  (host $DB_HOST:$DB_PORT)"
echo "  mode      : $( [ "$APPLY" = "1" ] && echo 'APPLY (DESTRUCTIVE overwrite)' || echo 'DRY-RUN (no changes)' )"

if [ "$APPLY" != "1" ]; then
  cat <<EOF

DRY-RUN only. Nothing was changed. To actually restore, re-run with APPLY=1.
It WOULD:
  1. CREATE DATABASE IF NOT EXISTS \`$RESTORE_TARGET_DB\`
  2. Pipe: gzip -dc "$DUMP_FILE" | mysql --one-database \`$RESTORE_TARGET_DB\`
     (this overwrites objects contained in the dump; --one-database is a
      rudimentary mysql-client filter added as defense-in-depth — NOT a security
      boundary — behind the fail-closed hazard scan above).
EOF
  exit 0
fi

# --- APPLY: perform the destructive restore ---------------------------------
echo "Ensuring target database exists..."
mysql --defaults-extra-file="$DEFAULTS_FILE" \
  -e "CREATE DATABASE IF NOT EXISTS \`$RESTORE_TARGET_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

echo "Restoring (this overwrites data)..."
set +e
gzip -dc "$DUMP_FILE" | mysql --defaults-extra-file="$DEFAULTS_FILE" --one-database "$RESTORE_TARGET_DB"
STATUS=${PIPESTATUS[1]}
set -e
[ "$STATUS" -eq 0 ] || die "Restore failed (mysql exit $STATUS). The target DB may be in a partial state — investigate before use."

echo "Restore into '$RESTORE_TARGET_DB' complete."

# --- Post-restore verification checklist (print; do NOT auto-run) -----------
cat <<'EOF'

================ POST-RESTORE VERIFICATION CHECKLIST ================
Run these against the RESTORED database (point DB_NAME/env at it first).
DB and evidence must have been restored as a CONSISTENT PAIR.

  1. Migrations up to date:
        npm run migrate:status
     (apply if needed:  npm run migrate)

  2. Audit hash chain intact (tamper-evidence):
        npm run audit:verify
     (script added by another Phase 10F contributor; confirm exact name)

  3. Evidence reconciliation — DRY-RUN first (no changes):
        npm run reconcile
     Investigate any dangling references before applying fixes.

  4. Completion snapshots readable / active risk policy present:
        npm run risk-policy

  5. Application readiness (after starting the app against this DB):
        curl -fsS http://127.0.0.1:4000/api/v1/ready
     Expect HTTP 200 {"status":"ready"}; 503 means a dependency is down.
====================================================================
EOF
