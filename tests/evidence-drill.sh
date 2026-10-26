#!/usr/bin/env bash
# Real isolated EVIDENCE backup->restore->verify drill.
# Uses rclone with LOCAL-type remotes as separate "storages" (primary / off-site /
# restored). Exercises scripts/backup-evidence.sh (rclone mode) end to end with REAL
# byte copies and SHA-256 retrieval, plus DB-reference integrity and negative cases.
# Requires: rclone, sha256sum. Run from the repo root.  (CI: deploy job installs rclone.)
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
command -v rclone    >/dev/null 2>&1 || { echo "SKIP: rclone not installed"; exit 0; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum required"; exit 1; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/eg-evdrill-XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
export RCLONE_CONFIG="$ROOT/rclone.conf"
rclone config create prim local >/dev/null
rclone config create off  local >/dev/null
rclone config create rest local >/dev/null
PRIM="$ROOT/primary"; OFF="$ROOT/offsite"; REST="$ROOT/restored"; mkdir -p "$PRIM" "$OFF" "$REST"

PASS=0; FAIL=0
chk(){ if [ "$1" = 1 ]; then echo "PASS: $2"; PASS=$((PASS+1)); else echo "FAIL: $2 -- ${3:-}"; FAIL=$((FAIL+1)); fi; }

# Synthetic evidence + a manifest simulating DB rows {object_key, sha256}.
: > "$ROOT/dbrefs.tsv"
for i in 1 2 3; do
  key="sig/$i.bin"; mkdir -p "$PRIM/sig"
  head -c $((1000 * i)) /dev/urandom > "$PRIM/$key"
  printf '%s\t%s\n' "$key" "$(sha256sum "$PRIM/$key" | awk '{print $1}')" >> "$ROOT/dbrefs.tsv"
done

# 1. backup primary -> off-site
res=0; EVIDENCE_TOOL=rclone DIRECTION=backup APPLY=1 EVIDENCE_SRC="prim:$PRIM" EVIDENCE_DEST="off:$OFF" \
  bash "$HERE/scripts/backup-evidence.sh" >/dev/null 2>&1 && res=1
chk "$res" "evidence backup primary -> off-site"

# 2. restore off-site -> restored (runs the script's real byte+SHA-256 verification)
out=$(EVIDENCE_TOOL=rclone DIRECTION=restore APPLY=1 EVIDENCE_DEST="off:$OFF" EVIDENCE_RESTORE_TO="rest:$REST" \
        bash "$HERE/scripts/backup-evidence.sh" 2>&1); rc=$?
res=0; { [ $rc -eq 0 ] && echo "$out" | grep -qi "VERIFIED"; } && res=1
chk "$res" "restore VERIFIED (rclone check --download passed)" "$out"

# 3. DB-reference integrity: retrieve RESTORED bytes and re-hash vs the recorded sha256
dbok=1
while IFS=$'\t' read -r key exp; do
  if ! rclone cat "rest:$REST/$key" > "$ROOT/got" 2>/dev/null; then echo "  MISSING restored: $key"; dbok=0; continue; fi
  act="$(sha256sum "$ROOT/got" | awk '{print $1}')"
  [ "$act" = "$exp" ] || { echo "  HASH MISMATCH restored: $key"; dbok=0; }
done < "$ROOT/dbrefs.tsv"
chk "$dbok" "restored bytes re-hash to the DB-recorded SHA-256 (not just a hash string in a table)"

# 4. NEGATIVE: corrupt a restored object -> the verification mechanism must fail non-zero
printf 'CORRUPT' >> "$REST/sig/1.bin"
res=0; rclone check "off:$OFF" "rest:$REST" --download >/dev/null 2>&1 || res=1
chk "$res" "negative(corrupt): corrupted restored object detected as non-zero"

# 5. NEGATIVE: missing restored object -> DB-reference retrieval must fail
rm -f "$REST/sig/2.bin"
res=0; rclone cat "rest:$REST/sig/2.bin" >/dev/null 2>&1 || res=1
chk "$res" "negative(missing): missing restored object detected"

echo ""
echo "evidence drill: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
