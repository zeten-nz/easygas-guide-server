#!/usr/bin/env bash
# Focused behaviour tests for the backup/restore deploy scripts.
# Uses STUBS + fixtures + real gzip/sha256sum -- NEVER connects to a real MySQL,
# so it is safe and fast in CI (no DB service required).
#
# Run from the repo root:  bash tests/deploy-scripts.test.sh
set -uo pipefail
shopt -s nullglob
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BK_SCRIPT="$HERE/scripts/backup-mysql.sh"
RS_SCRIPT="$HERE/scripts/restore-mysql.sh"
GZIP="$(command -v gzip)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/eg-deploytests-XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
# assert <condition-is-true?> <name> : pass if $1 == "1"
assert(){ if [ "$1" = "1" ]; then ok "$2"; else bad "$2"; fi; }
no_archive(){ local g=("$1"/*.sql.gz); [ "${#g[@]}" -eq 0 ]; }

STUB="$ROOT/bin"; mkdir -p "$STUB"
cat > "$STUB/mysqldump" <<'EOS'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = "--version" ] && { echo "mysqldump  Ver 8.0.0-stub"; exit 0; }; done
case "${STUB_DUMP_MODE:-ok}" in
  fail) echo "mysqldump: simulated failure" >&2; exit 2 ;;
  *) printf -- '-- MySQL dump (stub)\nCREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n-- Dump completed on 2026-01-01 0:00:00\n' ;;
esac
EOS
cat > "$STUB/mysql" <<'EOS'
#!/usr/bin/env bash
echo "mysql $*" >> "${STUB_MYSQL_LOG:-/dev/null}"
for a in "$@"; do [ "$a" = "-e" ] && exit 0; done   # CREATE DATABASE succeeds
exit "${STUB_MYSQL_EXIT:-0}"                          # import obeys STUB_MYSQL_EXIT
EOS
chmod +x "$STUB/mysqldump" "$STUB/mysql"
export PATH="$STUB:$PATH"

# ---- BACKUP ----
d="$ROOT/b1"; mkdir -p "$d"
out=$(STUB_DUMP_MODE=fail DB_USER=u DB_PASSWORD=p DB_NAME=demo BACKUP_DIR="$d" bash "$BK_SCRIPT" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -q "mysqldump failed" && no_archive "$d"; } && res=1
assert "$res" "backup: dump failure fails closed"

d="$ROOT/b2"; mkdir -p "$d"
cat > "$STUB/gzip" <<EOS
#!/usr/bin/env bash
for a in "\$@"; do [ "\$a" = "-c" ] && { echo "gzip: simulated compressor failure" >&2; exit 1; }; done
exec "$GZIP" "\$@"
EOS
chmod +x "$STUB/gzip"
out=$(DB_USER=u DB_PASSWORD=p DB_NAME=demo BACKUP_DIR="$d" bash "$BK_SCRIPT" 2>&1); rc=$?
rm -f "$STUB/gzip"
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "gzip/output-write failed" && no_archive "$d"; } && res=1
assert "$res" "backup: compressor failure fails closed"

d="$ROOT/b3"; mkdir -p "$d"
out=$(DB_USER=u DB_PASSWORD=p DB_NAME=demo BACKUP_DIR="$d" bash "$BK_SCRIPT" 2>&1); rc=$?
gz=("$d"/demo-*.sql.gz); GZ="${gz[0]:-}"
res=0
if [ $rc -eq 0 ] && [ -n "$GZ" ] && [ -f "$GZ.sha256" ] && [ -f "$GZ.manifest" ] && "$GZIP" -t "$GZ" \
   && [ "$(awk '{print $1}' "$GZ.sha256")" = "$(sha256sum "$GZ" | awk '{print $1}')" ]; then res=1; fi
assert "$res" "backup: success gives a valid archive + matching sha256 + manifest"
res=0; grep -q 'Refusing to overwrite existing backup' "$BK_SCRIPT" && res=1
assert "$res" "backup: no-overwrite guard present"

# ---- RESTORE ----
mkgz(){ printf '%s' "$2" | "$GZIP" -c > "$1"; }
T=easygas_restore_drill_test

f="$ROOT/corrupt.sql.gz"; head -c 20 /dev/urandom > "$f"; log="$ROOT/lA"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" APPLY=1 RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qiE "integrity check FAILED|Decompression FAILED" && [ ! -s "$log" ]; } && res=1
assert "$res" "restore: corrupt gzip rejected, mysql never called"

f="$ROOT/ctx.sql.gz"; mkgz "$f" $'USE `otherdb`;\nCREATE TABLE x(id int);\n'; log="$ROOT/lB"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" APPLY=1 RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "embeds CREATE DATABASE / USE" && [ ! -s "$log" ]; } && res=1
assert "$res" "restore: plain USE redirect rejected"

f="$ROOT/exec.sql.gz"; mkgz "$f" $'/*!40000 USE `sneaky`*/;\n/*!50003 CREATE DATABASE `evil` */;\n'; log="$ROOT/lC"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" APPLY=1 RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "embeds CREATE DATABASE / USE" && [ ! -s "$log" ]; } && res=1
assert "$res" "restore: executable-comment redirect rejected"

f="$ROOT/good.sql.gz"; mkgz "$f" $'CREATE TABLE ok(id int);\nINSERT INTO ok VALUES(1);\n'; log="$ROOT/lD"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" APPLY=1 RESTORE_TARGET_DB='bad;name test' CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "not a plain" && [ ! -s "$log" ]; } && res=1
assert "$res" "restore: invalid target identifier rejected before SQL"

log="$ROOT/lE"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" STUB_MYSQL_EXIT=1 APPLY=1 RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "PARTIAL/INCONSISTENT state"; } && res=1
assert "$res" "restore: import failure reports partial state"

log="$ROOT/lF"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1); rc=$?
res=0; { [ $rc -eq 0 ] && echo "$out" | grep -qi "DRY-RUN only" && [ ! -s "$log" ]; } && res=1
assert "$res" "restore: dry-run makes zero DB calls"

cp "$f" "$ROOT/prov.sql.gz"; sha256sum "$ROOT/prov.sql.gz" | awk '{print $1"  prov.sql.gz"}' > "$ROOT/prov.sql.gz.sha256"
out=$(RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$ROOT/prov.sql.gz" 2>&1)
res=0; echo "$out" | grep -qi "sha256 matches sidecar" && res=1
assert "$res" "restore: matching sha256 sidecar accepted"
echo "deadbeef  prov.sql.gz" > "$ROOT/prov.sql.gz.sha256"
out=$(RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$ROOT/prov.sql.gz" 2>&1); rc=$?
res=0; { echo "$out" | grep -qi "Checksum MISMATCH" && [ $rc -ne 0 ]; } && res=1
assert "$res" "restore: mismatching sha256 sidecar rejected"

echo ""
echo "deploy-scripts tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
