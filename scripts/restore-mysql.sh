#!/usr/bin/env bash
#
# EASY GAS — MySQL restore  ***DESTRUCTIVE***
# ===========================================
#
# Overwrites a target database with a gzip dump produced by
# scripts/backup-mysql.sh. It DEFAULTS TO DRY-RUN and validates the ENTIRE
# artifact BEFORE touching any database.
#
# To actually write, ALL of these must hold:
#   * a dump file is passed as $1 and exists,
#   * RESTORE_TARGET_DB is set to a plain [A-Za-z0-9_] identifier,
#   * CONFIRM_RESTORE=yes,
#   * APPLY=1,
#   * and, if RESTORE_TARGET_DB does NOT end in "_test", FORCE_PROD_RESTORE=yes.
#
# ISOLATION FOR DRILLS: the "_test" suffix is only a naming GUARD-RAIL against a
# fat-finger — it is NOT an isolation boundary. A restore drill MUST run against a
# SEPARATE, DISPOSABLE MySQL instance with its own restricted credentials and no
# network path to development/production — never merely a differently-named schema
# on a shared privileged server. See docs/BACKUP-RESTORE-10F.md.
#
# TRUST: only restore artifacts of KNOWN PROVENANCE (produced by
# scripts/backup-mysql.sh). If the dump has a "<file>.sha256" sidecar it is
# verified. There is deliberately NO flag that skips integrity validation.
#
# Reads DB connection config from the environment (never echoes the password;
# uses a temp --defaults-extra-file with 0600 perms). For cron/non-interactive
# use, load env via `node scripts/with-env.mjs` — never `source` a dotenv file.
#     DB_HOST (default 127.0.0.1), DB_PORT (default 3306), DB_USER (required),
#     DB_PASSWORD (may be empty)
#
# Usage (safe dry-run — DEFAULT; a *_test target needs no force flag):
#     RESTORE_TARGET_DB=easygas_restore_drill_test CONFIRM_RESTORE=yes \
#       DB_USER=... DB_PASSWORD=... bash scripts/restore-mysql.sh dump.sql.gz
# Usage (apply to a disposable *_test drill DB):
#     APPLY=1 RESTORE_TARGET_DB=easygas_restore_drill_test CONFIRM_RESTORE=yes \
#       DB_USER=... DB_PASSWORD=... bash scripts/restore-mysql.sh dump.sql.gz
# (A non-*_test target additionally requires FORCE_PROD_RESTORE=yes — see the guard below.)
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

command -v mysql     >/dev/null 2>&1 || die "mysql client not found on PATH"
command -v gzip      >/dev/null 2>&1 || die "gzip not found on PATH"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum not found on PATH"

# --- Input guards (fail closed) ---------------------------------------------
[ -n "$DUMP_FILE" ]            || die "No dump file given. Usage: restore-mysql.sh <dump.sql.gz>"
[ -f "$DUMP_FILE" ]            || die "Dump file not found: $DUMP_FILE"
[ -n "$DB_USER" ]             || die "DB_USER is empty — refusing."
[ -n "$RESTORE_TARGET_DB" ]   || die "RESTORE_TARGET_DB is empty — set the database to restore INTO."
[ "$CONFIRM_RESTORE" = "yes" ] || die "CONFIRM_RESTORE is not 'yes' — refusing (typed confirmation required)."

# --- (E.5) Validate the target identifier BEFORE it is ever put into SQL -----
[[ "$RESTORE_TARGET_DB" =~ ^[A-Za-z0-9_]+$ ]] \
  || die "RESTORE_TARGET_DB '$RESTORE_TARGET_DB' is not a plain [A-Za-z0-9_] identifier — refusing (would be unsafe to interpolate into SQL)."

# Production-shaped target requires the extra explicit force flag (guard-rail).
if [[ "$RESTORE_TARGET_DB" != *_test ]]; then
  [ "$FORCE_PROD_RESTORE" = "yes" ] \
    || die "Target '$RESTORE_TARGET_DB' does not end in '_test' (looks like production). Set FORCE_PROD_RESTORE=yes to allow. Refusing."
  echo "WARNING: restoring into a NON-test database '$RESTORE_TARGET_DB' (FORCE_PROD_RESTORE=yes)."
fi

# --- Private temp workspace; everything cleaned on ANY exit ------------------
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/easygas-restore-XXXXXX")"
chmod 700 "$WORK_DIR"
DEFAULTS_FILE="${WORK_DIR}/client.cnf"
TMP_GZ="${WORK_DIR}/input.sql.gz"
TMP_SQL="${WORK_DIR}/input.sql"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT INT TERM

# --- (E.9) Snapshot the artifact so the bytes we VALIDATE are the bytes we USE
cp -- "$DUMP_FILE" "$TMP_GZ" || die "Could not copy dump to the private workspace."

# --- (E.8) Integrity metadata + TRUST CONTRACT ------------------------------
# TRUST CONTRACT (explicit): a matching adjacent ".sha256" proves the artifact is
# INTACT relative to that checksum (not corrupt/truncated). It is NOT authenticated
# provenance — anyone who can replace the dump can replace its sidecar too, so a
# match does not prove the dump came from a trusted source. Authenticated provenance
# would need a signature over a trusted channel (out of scope here). Only restore
# artifacts you already trust — produced by scripts/backup-mysql.sh.
#
# NORMAL PATH: scripts/backup-mysql.sh ALWAYS writes a ".sha256" sidecar, so APPLY
# REQUIRES it. A missing sidecar means this is not a standard artifact; to APPLY a
# LEGACY/foreign dump you must opt in EXPLICITLY (and it is never reported as verified).
ALLOW_UNVERIFIED_ARTIFACT="${ALLOW_UNVERIFIED_ARTIFACT:-}"
if [ -f "${DUMP_FILE}.sha256" ]; then
  EXPECTED="$(awk '{print $1}' "${DUMP_FILE}.sha256")"
  ACTUAL="$(sha256sum "$TMP_GZ" | awk '{print $1}')"
  [ -n "$EXPECTED" ] || die "Sidecar ${DUMP_FILE}.sha256 is empty/unreadable — refusing."
  [ "$EXPECTED" = "$ACTUAL" ] \
    || die "Checksum MISMATCH: sidecar says $EXPECTED, artifact is $ACTUAL. Refusing (corrupt or altered RELATIVE TO THE SIDECAR)."
  echo "Integrity: sha256 matches the adjacent sidecar ($ACTUAL) — intact relative to that checksum (NOT authenticated provenance)."
elif [ "$APPLY" = "1" ] && [ "$ALLOW_UNVERIFIED_ARTIFACT" != "yes" ]; then
  die "No '${DUMP_FILE}.sha256' sidecar — refusing to APPLY an artifact without integrity metadata. Restore a scripts/backup-mysql.sh artifact (it writes the sidecar), or set ALLOW_UNVERIFIED_ARTIFACT=yes to APPLY a LEGACY/foreign artifact explicitly (it will NOT be treated as verified)."
else
  MSG="WARNING: no '${DUMP_FILE}.sha256' sidecar — integrity is UNVERIFIED."
  [ "$APPLY" = "1" ] && MSG="$MSG Proceeding under explicit ALLOW_UNVERIFIED_ARTIFACT=yes (legacy/foreign artifact; NOT verified)."
  echo "$MSG"
fi

# --- (E.2/E.3) Validate integrity + decompress ONCE, before any DB mutation --
gzip -t "$TMP_GZ" || die "gzip integrity check FAILED — the archive is corrupt/truncated. Refusing (no DB was touched)."
# Decompress the validated snapshot to a plain SQL file; gzip exit is checked
# directly (no pipe → no swallowed status). This TMP_SQL is what mysql consumes.
if ! gzip -dc "$TMP_GZ" > "$TMP_SQL"; then
  die "Decompression FAILED — refusing (no DB was touched)."
fi
[ -s "$TMP_SQL" ] || die "Decompressed SQL is empty — refusing (no DB was touched)."

# --- (E.6) Reject a dump that carries its OWN database context ---------------
# `mysqldump --databases/--all-databases` embeds line-start `CREATE DATABASE …`
# and `USE <db>;` (including the executable `/*!NNNNN … */` comment wrapper that
# real mysql runs). Piped into `mysql`, a `USE` line SILENTLY redirects every
# statement to the dump's own database, ignoring RESTORE_TARGET_DB.
#
# This is DEFENSE-IN-DEPTH, NOT a security boundary — a hand-crafted dump could
# still evade a line-anchored scan (e.g. a `USE` after `;` mid-line). The real
# guarantee is (a) restoring only trusted artifacts from scripts/backup-mysql.sh
# (which dump a SINGLE database positionally and emit no CREATE DATABASE/USE),
# and (b) an isolated disposable target. We do NOT claim that scrubbing lines
# makes an arbitrary/untrusted dump safe — it does not.
# shellcheck disable=SC2016  # the $ is a literal regex char; single quotes are intentional
HAZARD_HITS="$(grep -ciE '^[[:space:]]*(/\*![0-9]*[[:space:]]+)?(CREATE[[:space:]]+DATABASE\b|USE[[:space:]]+`?[A-Za-z0-9_$]+`?)' "$TMP_SQL" || true)"
if [ "${HAZARD_HITS:-0}" != "0" ]; then
  die "Dump embeds CREATE DATABASE / USE ($HAZARD_HITS line(s)) and would target its OWN database, ignoring RESTORE_TARGET_DB='$RESTORE_TARGET_DB'. This is not a dump from scripts/backup-mysql.sh. Refusing (no DB was touched)."
fi

echo "Artifact validated: integrity OK, single-database (no embedded USE/CREATE DATABASE)."

# --- Secret handling: temp defaults-extra-file (0600) -----------------------
: > "$DEFAULTS_FILE"; chmod 600 "$DEFAULTS_FILE"
{
  echo "[client]"
  echo "user=${DB_USER}"
  echo "password=${DB_PASSWORD}"
  echo "host=${DB_HOST}"
  echo "port=${DB_PORT}"
} > "$DEFAULTS_FILE"

# --- Plan ------------------------------------------------------------------
echo "Restore plan:"
echo "  dump file : $DUMP_FILE"
echo "  target DB : $RESTORE_TARGET_DB  (host $DB_HOST:$DB_PORT)"
echo "  mode      : $( [ "$APPLY" = "1" ] && echo 'APPLY (DESTRUCTIVE overwrite)' || echo 'DRY-RUN (no changes)' )"

if [ "$APPLY" != "1" ]; then
  cat <<EOF

DRY-RUN only — the artifact was fully validated above and NOTHING was changed.
To actually restore, re-run with APPLY=1. It WOULD:
  1. CREATE DATABASE IF NOT EXISTS \`$RESTORE_TARGET_DB\`
  2. mysql \`$RESTORE_TARGET_DB\` < <validated-decompressed-sql>
EOF
  exit 0
fi

# --- APPLY: perform the destructive restore ---------------------------------
echo "Ensuring target database exists..."
mysql --defaults-extra-file="$DEFAULTS_FILE" \
  -e "CREATE DATABASE IF NOT EXISTS \`$RESTORE_TARGET_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" \
  || die "Could not ensure target database exists (no data was imported)."

echo "Restoring (this overwrites objects contained in the dump)..."
# Feed the VALIDATED temp SQL file directly (no gzip in this pipe → the mysql
# exit status is authoritative; nothing to swallow).
if ! mysql --defaults-extra-file="$DEFAULTS_FILE" "$RESTORE_TARGET_DB" < "$TMP_SQL"; then
  die "Restore FAILED (mysql error). The target '$RESTORE_TARGET_DB' may now be in a PARTIAL/INCONSISTENT state — investigate and do NOT use it until re-restored from a good artifact."
fi

echo "Restore into '$RESTORE_TARGET_DB' complete."

# --- Post-restore verification checklist (print; do NOT auto-run) -----------
cat <<'EOF'

================ POST-RESTORE VERIFICATION CHECKLIST ================
Run these against the RESTORED database (point DB_NAME/env at it first).
DB and evidence must have been restored as a reconciled recovery point
(see docs/BACKUP-RESTORE-10F.md — nearby schedules are NOT a consistency proof).

  1. Migrations recorded/pending:      npm run migrate:status
     (bookkeeping only — NOT a full schema verification)
  2. Audit hash chain consistency:     npm run audit:verify
     (consistency of the chain — NOT proof that no history was lost)
  3. Evidence reconciliation (DRY-RUN):  npm run reconcile
     (investigate dangling references before applying any fix)
  4. Active risk policy present:       npm run risk-policy
  5. App readiness (after starting against this DB, on the PRIVATE port):
        curl -fsS http://127.0.0.1:4000/api/v1/ready
     Expect 200 {"status":"ready"}; 503 means a dependency is down.
====================================================================
EOF
