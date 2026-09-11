#!/usr/bin/env bash
#
# EASY GAS — evidence object-storage off-site backup & retrieval
# =============================================================
#
# SAFE BY DEFAULT (dry-run). Copies the PRIVATE evidence store (customer
# signatures, step photos, completion snapshots) to/from an OFF-SITE, VERSIONED
# destination. Copy/sync only — it NEVER deletes from the source.
#
# Credentials come from the ENVIRONMENT / your cloud CLI profile. This script
# NEVER embeds or echoes credentials.
#
# ---------------------------------------------------------------------------
# ONE TOOL, EXPLICITLY. aws-cli and rclone do NOT share remote syntax, so you
# choose which tool this run uses and give it that tool's OWN paths:
#
#   EVIDENCE_TOOL=aws     (default) — S3 URIs:      s3://bucket/prefix
#   EVIDENCE_TOOL=rclone            — rclone remotes: remotename:bucket/prefix
#
# Passing an `s3://...` path to rclone (or a `remote:...` path to aws) is a
# configuration error and this script refuses it.
#
# ---------------------------------------------------------------------------
# DIRECTION:
#   DIRECTION=backup  (default) — copy EVIDENCE_SRC  → EVIDENCE_DEST (off-site)
#   DIRECTION=restore           — copy EVIDENCE_DEST → EVIDENCE_RESTORE_TO
#                                 (retrieve the off-site copy to a recovery target)
#
# APPLY=1 performs the copy; default is DRY-RUN (prints what it WOULD do).
#
# Required (backup):  EVIDENCE_SRC, EVIDENCE_DEST
# Required (restore): EVIDENCE_DEST, EVIDENCE_RESTORE_TO
# Optional: EVIDENCE_TOOL (aws|rclone), APPLY, AWS_PROFILE/AWS_REGION/RCLONE_CONFIG
#
# The off-site DESTINATION MUST: be PRIVATE, have OBJECT VERSIONING enabled, be
# encrypted at rest, and ideally live in a DIFFERENT account/region (separate
# failure domain). This script relies on those; it does not create them.
#
# CONSISTENCY (be honest): a DB backup and this evidence copy taken minutes apart
# are NOT a transactionally consistent pair. The DB references evidence objects by
# key + sha256; the safe recovery model is (a) VERSIONING on both stores so no
# referenced version is lost, and (b) RECONCILIATION at the chosen recovery point
# (npm run reconcile, dry-run first) to detect/repair any dangling reference. This
# script does NOT implement PITR.
#
# RPO / RTO / RETENTION are a BUSINESS DECISION — intentionally not hard-coded here
# (see docs/BACKUP-RESTORE-10F.md). Measured drill durations are NOT a promised RTO.
#
set -euo pipefail

EVIDENCE_TOOL="${EVIDENCE_TOOL:-aws}"
DIRECTION="${DIRECTION:-backup}"
EVIDENCE_SRC="${EVIDENCE_SRC:-}"
EVIDENCE_DEST="${EVIDENCE_DEST:-}"
EVIDENCE_RESTORE_TO="${EVIDENCE_RESTORE_TO:-}"
APPLY="${APPLY:-0}"

die() { echo "ERROR: $*" >&2; exit 1; }

# Verification downloads bytes into a private temp dir; always clean it up.
_VTMP=""
trap 'rm -rf "${_VTMP:-}" 2>/dev/null || true' EXIT

# Resolve FROM/TO by direction.
case "$DIRECTION" in
  backup)
    [ -n "$EVIDENCE_SRC" ]  || die "EVIDENCE_SRC is empty — set the source (primary) evidence path."
    [ -n "$EVIDENCE_DEST" ] || die "EVIDENCE_DEST is empty — set the off-site destination path."
    FROM="$EVIDENCE_SRC"; TO="$EVIDENCE_DEST" ;;
  restore)
    [ -n "$EVIDENCE_DEST" ]       || die "EVIDENCE_DEST is empty — set the off-site source to retrieve FROM."
    [ -n "$EVIDENCE_RESTORE_TO" ] || die "EVIDENCE_RESTORE_TO is empty — set where to retrieve the evidence INTO."
    FROM="$EVIDENCE_DEST"; TO="$EVIDENCE_RESTORE_TO" ;;
  *) die "DIRECTION must be 'backup' or 'restore' (got '$DIRECTION')." ;;
esac
[ "$FROM" != "$TO" ] || die "FROM and TO are identical — refusing."

# --- Validate paths match the chosen tool's syntax (F.1) --------------------
is_s3()     { [[ "$1" == s3://* ]]; }
is_rclone() { [[ "$1" =~ ^[A-Za-z0-9_-]+:.+ ]] && [[ "$1" != s3://* ]]; }
case "$EVIDENCE_TOOL" in
  aws)
    if ! is_s3 "$FROM" || ! is_s3 "$TO"; then
      die "EVIDENCE_TOOL=aws requires s3:// paths (got FROM='$FROM' TO='$TO'). For an rclone remote (remote:bucket) set EVIDENCE_TOOL=rclone."
    fi
    command -v aws >/dev/null 2>&1 || die "EVIDENCE_TOOL=aws but 'aws' is not on PATH." ;;
  rclone)
    if ! is_rclone "$FROM" || ! is_rclone "$TO"; then
      die "EVIDENCE_TOOL=rclone requires 'remote:bucket/prefix' paths, NOT s3:// (got FROM='$FROM' TO='$TO'). aws-cli s3:// paths are not valid rclone remotes."
    fi
    command -v rclone >/dev/null 2>&1 || die "EVIDENCE_TOOL=rclone but 'rclone' is not on PATH." ;;
  *) die "EVIDENCE_TOOL must be 'aws' or 'rclone' (got '$EVIDENCE_TOOL')." ;;
esac

MODE="$( [ "$APPLY" = "1" ] && echo 'APPLY (will copy objects)' || echo 'DRY-RUN (no changes; set APPLY=1 to copy)' )"
echo "Evidence $DIRECTION via $EVIDENCE_TOOL — $MODE"
echo "  from: $FROM"
echo "  to:   $TO"

# --- Copy (additive; never --delete, so versioning keeps history) -----------
case "$EVIDENCE_TOOL" in
  aws)
    ARGS=(s3 sync "$FROM" "$TO" --only-show-errors)
    [ "$APPLY" != "1" ] && ARGS+=(--dryrun)
    aws "${ARGS[@]}" ;;
  rclone)
    ARGS=(copy "$FROM" "$TO")
    [ "$APPLY" != "1" ] && ARGS+=(--dry-run)
    rclone "${ARGS[@]}" ;;
esac
echo "Evidence $DIRECTION step complete ($MODE)."

# --- Retrieval verification (restore + apply): REAL bytes + SHA-256 ---------
# Downloads the ACTUAL bytes of every object from BOTH the off-site source and the
# restored copy and compares SHA-256 (never ETag — ETag is not a content hash for
# multipart objects and is provider-specific). Any missing or mismatched object
# makes this FAIL with a non-zero exit; "VERIFIED" is printed only after every
# object passes. Set EVIDENCE_VERIFY=0 to skip (not recommended).
if [ "$DIRECTION" = "restore" ] && [ "$APPLY" = "1" ] && [ "${EVIDENCE_VERIFY:-1}" = "1" ]; then
  echo "Verifying restored evidence against the off-site source (retrieved bytes + SHA-256)..."
  case "$EVIDENCE_TOOL" in
    aws)
      command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required for verification but was not found."
      _VTMP="$(mktemp -d "${TMPDIR:-/tmp}/eg-evverify-XXXXXX")"
      # Empty temp dirs → both syncs download the real object bytes (no skipping).
      aws s3 sync "$FROM" "$_VTMP/src" --only-show-errors || die "Verification failed: could not retrieve off-site source bytes."
      aws s3 sync "$TO"   "$_VTMP/dst" --only-show-errors || die "Verification failed: could not retrieve restored bytes."
      fails=0; checked=0
      while IFS= read -r -d '' f; do
        rel="${f#"$_VTMP"/src/}"; checked=$((checked + 1))
        if [ ! -f "$_VTMP/dst/$rel" ]; then echo "  MISSING in restore: $rel" >&2; fails=$((fails + 1)); continue; fi
        ha="$(sha256sum "$f" | awk '{print $1}')"
        hb="$(sha256sum "$_VTMP/dst/$rel" | awk '{print $1}')"
        [ "$ha" = "$hb" ] || { echo "  HASH MISMATCH: $rel ($ha != $hb)" >&2; fails=$((fails + 1)); }
      done < <(find "$_VTMP/src" -type f -print0)
      [ "$checked" -gt 0 ] || die "Verification failed: no objects found at the off-site source '$FROM'."
      [ "$fails" -eq 0 ] || die "Verification FAILED: $fails of $checked object(s) missing or hash-mismatched."
      echo "Evidence restore VERIFIED: $checked object(s) retrieved, all SHA-256 match."
      ;;
    rclone)
      # `rclone check --download` retrieves BOTH sides' bytes and compares them;
      # it exits non-zero if any object is missing or differs. This actually RUNS
      # the verification (it is not a printed suggestion).
      rclone check "$FROM" "$TO" --download || die "Verification FAILED: rclone check --download found missing/differing objects."
      echo "Evidence restore VERIFIED: rclone check --download reported no differences."
      ;;
  esac
  echo "For DB-reference integrity, also run the app-level reconcile (dry-run): npm run reconcile"
fi

# ---------------------------------------------------------------------------
# REMINDERS (comments only):
#   * Confirm the destination has VERSIONING + encryption + a separate failure
#     domain — this script relies on them; it does not create them.
#   * Periodically run DIRECTION=restore (to a scratch target) + the reconcile
#     dry-run to prove the off-site copy is actually recoverable.
#   * Recovery point = DB backup + evidence versions reconciled; nearby schedules
#     alone are NOT a consistency guarantee.
# ---------------------------------------------------------------------------
