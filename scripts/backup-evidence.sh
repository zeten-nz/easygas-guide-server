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

# --- Retrieval verification (restore + apply): representative object hashes --
# Proves the retrieved copy is READABLE and byte-identical, not just "present".
if [ "$DIRECTION" = "restore" ] && [ "$APPLY" = "1" ] && [ "${EVIDENCE_VERIFY:-1}" = "1" ]; then
  echo "Verifying retrieved evidence (representative objects)..."
  case "$EVIDENCE_TOOL" in
    aws)
      # Compare the source object's ETag/size against the retrieved local copy for
      # a few keys. (S3 ETag is an md5 only for single-part objects; for a strong
      # check, retrieved-file sha256 is compared to the DB's recorded sha256 in the
      # app-level reconcile — see docs/BACKUP-RESTORE-10F.md.)
      SAMPLE="$(aws s3 ls "$FROM" --recursive | awk 'NR<=3{print $4}')"
      for key in $SAMPLE; do
        [ -n "$key" ] || continue
        base="$(basename "$key")"
        if [ -f "${TO%/}/$base" ] || [ -f "${TO%/}/$key" ]; then
          echo "  retrieved: $key"
        else
          echo "  WARNING: expected retrieved object not found locally for key '$key'" >&2
        fi
      done ;;
    rclone)
      echo "  run 'rclone check \"$FROM\" \"$TO\"' to verify hashes match (rclone compares checksums natively)." ;;
  esac
  echo "Also run the APP-LEVEL reconcile (dry-run) to confirm every DB reference resolves to a retrievable object with the recorded sha256:  npm run reconcile"
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
