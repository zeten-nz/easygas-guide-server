#!/usr/bin/env bash
# Focused behaviour tests for the backup/restore deploy scripts.
# Uses STUBS + fixtures + real gzip/sha256sum -- NEVER connects to a real MySQL,
# so it is safe and fast in CI (no DB service required). Object-storage retrieval
# and Nginx integration are exercised by SEPARATE CI jobs (real disposable services).
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
assert(){ if [ "$1" = "1" ]; then ok "$2"; else bad "$2"; fi; }
skip(){ echo "SKIP: $1"; }
no_archive(){ local g=("$1"/*.sql.gz); [ "${#g[@]}" -eq 0 ]; }
no_partial(){ local g=("$1"/.*.partial); [ "${#g[@]}" -eq 0 ]; }

STUB="$ROOT/bin"; mkdir -p "$STUB"
cat > "$STUB/mysqldump" <<'EOS'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = "--version" ] && { echo "mysqldump  Ver 8.0.0-stub"; exit 0; }; done
case "${STUB_DUMP_MODE:-ok}" in
  fail) echo "mysqldump: simulated failure" >&2; exit 2 ;;
  big)  head -c "${STUB_DUMP_BYTES:-5000000}" /dev/urandom ;;   # incompressible bulk
  *)    printf -- '-- MySQL dump (stub)\nCREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n-- Dump completed on 2026-01-01 0:00:00\n' ;;
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
mksidecar(){ sha256sum "$1" | awk -v f="$(basename "$1")" '{print $1"  "f}' > "$1.sha256"; }

echo "================= BACKUP ================="
# 1. dump failure -> fail closed
d="$ROOT/b1"; mkdir -p "$d"
out=$(STUB_DUMP_MODE=fail DB_USER=u DB_PASSWORD=p DB_NAME=demo BACKUP_DIR="$d" bash "$BK_SCRIPT" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -q "mysqldump failed" && no_archive "$d" && no_partial "$d"; } && res=1
assert "$res" "backup: dump failure fails closed (no artifact, no temp)"

# 2. COMPRESSOR failure (gzip stub errors on -c, before any write)
d="$ROOT/b2"; mkdir -p "$d"
cat > "$STUB/gzip" <<EOS
#!/usr/bin/env bash
for a in "\$@"; do [ "\$a" = "-c" ] && { echo "gzip: simulated COMPRESSOR failure" >&2; exit 1; }; done
exec "$GZIP" "\$@"
EOS
chmod +x "$STUB/gzip"
out=$(DB_USER=u DB_PASSWORD=p DB_NAME=demo BACKUP_DIR="$d" bash "$BK_SCRIPT" 2>&1); rc=$?
rm -f "$STUB/gzip"
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "gzip/output-write failed" && no_archive "$d" && no_partial "$d"; } && res=1
assert "$res" "backup: compressor failure fails closed"

# 3. REAL OUTPUT-WRITE failure (real gzip, file-size limit exceeded by incompressible
#    bulk). Distinct from #2: gzip itself works; the WRITE to disk fails. Needs a
#    settable `ulimit -f` (Linux CI); skipped where the shell cannot set it (e.g.
#    Git Bash on Windows) rather than faked.
d="$ROOT/b3"; mkdir -p "$d"
if ( ulimit -f 200 2>/dev/null && [ "$(ulimit -f)" = "200" ] ) 2>/dev/null; then
  out=$( ulimit -f 200; STUB_DUMP_MODE=big STUB_DUMP_BYTES=6000000 DB_USER=u DB_PASSWORD=p DB_NAME=demo BACKUP_DIR="$d" bash "$BK_SCRIPT" 2>&1 ); rc=$?
  res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "gzip/output-write failed" && no_archive "$d" && no_partial "$d"; } && res=1
  assert "$res" "backup: real output-write failure (disk/size limit) fails closed"
else
  skip "backup: real output-write failure — 'ulimit -f' not settable here (runs for real in Linux CI)"
fi

# 4. success -> valid archive + sidecars + integrity
d="$ROOT/b4"; mkdir -p "$d"
out=$(DB_USER=u DB_PASSWORD=p DB_NAME=demo BACKUP_DIR="$d" bash "$BK_SCRIPT" 2>&1); rc=$?
gz=("$d"/demo-*.sql.gz); GZ="${gz[0]:-}"
res=0
if [ $rc -eq 0 ] && [ -n "$GZ" ] && [ -f "$GZ.sha256" ] && [ -f "$GZ.manifest" ] && "$GZIP" -t "$GZ" \
   && [ "$(awk '{print $1}' "$GZ.sha256")" = "$(sha256sum "$GZ" | awk '{print $1}')" ]; then res=1; fi
assert "$res" "backup: success gives a valid archive + matching sha256 + manifest"

# 5. REAL no-overwrite collision: deterministic name via a `date` stub; the existing
#    artifact must be LEFT UNCHANGED and no temp left behind.
d="$ROOT/b5"; mkdir -p "$d"
cat > "$STUB/date" <<'EOS'
#!/usr/bin/env bash
echo "FIXEDTS"
EOS
chmod +x "$STUB/date"
EXIST="$d/demo-FIXEDTS.sql.gz"
printf 'SENTINEL-DO-NOT-CLOBBER' > "$EXIST"
before="$(sha256sum "$EXIST" | awk '{print $1}')"
out=$(DB_USER=u DB_PASSWORD=p DB_NAME=demo BACKUP_DIR="$d" bash "$BK_SCRIPT" 2>&1); rc=$?
rm -f "$STUB/date"
after="$(sha256sum "$EXIST" | awk '{print $1}')"
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "Refusing to overwrite existing backup" \
        && [ "$before" = "$after" ] && [ "$(cat "$EXIST")" = "SENTINEL-DO-NOT-CLOBBER" ] && no_partial "$d"; } && res=1
assert "$res" "backup: real collision refuses AND leaves the existing artifact unchanged"

echo "================= RESTORE ================="
mkgz(){ printf '%s' "$2" | "$GZIP" -c > "$1"; }
T=easygas_restore_drill_test

# A. corrupt/truncated gzip (dry-run: validation runs before the dry/apply split)
f="$ROOT/corrupt.sql.gz"; head -c 20 /dev/urandom > "$f"; log="$ROOT/lA"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qiE "integrity check FAILED|Decompression FAILED" && [ ! -s "$log" ]; } && res=1
assert "$res" "restore: corrupt gzip rejected, mysql never called"

# B. plain USE redirect (dry-run)
f="$ROOT/ctx.sql.gz"; mkgz "$f" $'USE `otherdb`;\nCREATE TABLE x(id int);\n'; log="$ROOT/lB"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "embeds CREATE DATABASE / USE" && [ ! -s "$log" ]; } && res=1
assert "$res" "restore: plain USE redirect rejected"

# C. executable-comment redirect (dry-run)
f="$ROOT/exec.sql.gz"; mkgz "$f" $'/*!40000 USE `sneaky`*/;\n/*!50003 CREATE DATABASE `evil` */;\n'; log="$ROOT/lC"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "embeds CREATE DATABASE / USE" && [ ! -s "$log" ]; } && res=1
assert "$res" "restore: executable-comment redirect rejected"

# D. invalid target identifier (checked before any SQL)
f="$ROOT/good.sql.gz"; mkgz "$f" $'CREATE TABLE ok(id int);\nINSERT INTO ok VALUES(1);\n'; mksidecar "$f"; log="$ROOT/lD"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" APPLY=1 RESTORE_TARGET_DB='bad;name test' CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "not a plain" && [ ! -s "$log" ]; } && res=1
assert "$res" "restore: invalid target identifier rejected before SQL"

# E. mysql IMPORT failure with a matching sidecar (reaches the import, reports partial state)
log="$ROOT/lE"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" STUB_MYSQL_EXIT=1 APPLY=1 RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "PARTIAL/INCONSISTENT state"; } && res=1
assert "$res" "restore: import failure reports partial state"

# F. dry-run makes zero DB calls (no sidecar → warning only, dry-run changes nothing)
NOSC="$ROOT/nosc.sql.gz"; mkgz "$NOSC" $'CREATE TABLE ok(id int);\n'; log="$ROOT/lF"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$NOSC" 2>&1); rc=$?
res=0; { [ $rc -eq 0 ] && echo "$out" | grep -qi "DRY-RUN only" && [ ! -s "$log" ]; } && res=1
assert "$res" "restore: dry-run makes zero DB calls"

# G. TRUST CONTRACT: matching sidecar = intact RELATIVE TO THE CHECKSUM (not provenance)
out=$(RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$f" 2>&1)
res=0; { echo "$out" | grep -qi "intact relative to that checksum" && echo "$out" | grep -qi "NOT authenticated provenance"; } && res=1
assert "$res" "restore: matching sidecar reported as integrity-relative-to-checksum, not provenance"
cp "$f.sha256" "$ROOT/mm.sha256"; cp "$f" "$ROOT/mm.sql.gz"; echo "deadbeef  mm.sql.gz" > "$ROOT/mm.sql.gz.sha256"
out=$(RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$ROOT/mm.sql.gz" 2>&1); rc=$?
res=0; { echo "$out" | grep -qi "Checksum MISMATCH" && [ $rc -ne 0 ]; } && res=1
assert "$res" "restore: mismatching sidecar rejected"

# H. APPLY without a sidecar is REFUSED (integrity metadata required for the normal path)
log="$ROOT/lH"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" APPLY=1 RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$NOSC" 2>&1); rc=$?
res=0; { [ $rc -ne 0 ] && echo "$out" | grep -qi "refusing to APPLY an artifact without integrity metadata" && [ ! -s "$log" ]; } && res=1
assert "$res" "restore: APPLY without sidecar is refused"

# I. Legacy override APPLYs WITHOUT claiming verification
log="$ROOT/lI"; : > "$log"
out=$(STUB_MYSQL_LOG="$log" ALLOW_UNVERIFIED_ARTIFACT=yes APPLY=1 RESTORE_TARGET_DB=$T CONFIRM_RESTORE=yes DB_USER=u DB_PASSWORD=p bash "$RS_SCRIPT" "$NOSC" 2>&1); rc=$?
res=0; { [ $rc -eq 0 ] && echo "$out" | grep -qi "UNVERIFIED" && ! echo "$out" | grep -qi "sha256 matches" && [ -s "$log" ]; } && res=1
assert "$res" "restore: explicit legacy override applies but is NOT reported as verified"

echo ""
echo "deploy-scripts tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
