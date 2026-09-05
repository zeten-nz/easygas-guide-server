#!/usr/bin/env bash
#
# EASY GAS — evidence object-storage off-site backup (Phase 10F artifact)
# ======================================================================
#
# SAFE BY DEFAULT (dry-run). Replicates the PRIVATE evidence bucket (customer
# signatures, step photos, completion snapshots) to an OFF-SITE bucket that has
# VERSIONING enabled, so an accidental delete/overwrite on the primary can be
# recovered. This is a copy/sync — it does NOT delete from the source.
#
# Credentials: taken from the ENVIRONMENT / your cloud CLI profile (AWS
# credential chain, or an rclone remote). This script NEVER embeds or echoes
# credentials.
#
# Required environment:
#     EVIDENCE_SRC   source bucket/prefix   (e.g. s3://easygas-evidence)
#     EVIDENCE_DEST  off-site bucket/prefix (e.g. s3://easygas-evidence-dr)
# Optional:
#     APPLY=1        actually perform the sync (default: DRY-RUN, prints only)
#     AWS_PROFILE / AWS_REGION / RCLONE_CONFIG ... (standard tool config)
#
# The destination bucket MUST:
#   * be PRIVATE (evidence is sensitive — never public),
#   * have OBJECT VERSIONING enabled (so overwrites/deletes are recoverable),
#   * ideally be in a different account/region for disaster resilience,
#   * be encrypted at rest.
#
# IMPORTANT: take this evidence backup and the MySQL backup (backup-mysql.sh)
# as a CONSISTENT PAIR. The database rows reference these objects; restoring one
# without the other yields dangling references or orphaned files. Schedule them
# close together (see deploy/crontab.example) and treat them as one recovery
# point.
#
# Usage (dry-run):
#     EVIDENCE_SRC=s3://easygas-evidence EVIDENCE_DEST=s3://easygas-evidence-dr \
#         bash scripts/backup-evidence.sh
# Usage (apply):
#     APPLY=1 EVIDENCE_SRC=... EVIDENCE_DEST=... bash scripts/backup-evidence.sh
#
set -euo pipefail

EVIDENCE_SRC="${EVIDENCE_SRC:-}"
EVIDENCE_DEST="${EVIDENCE_DEST:-}"
APPLY="${APPLY:-0}"

die() { echo "ERROR: $*" >&2; exit 1; }

# Fail closed without explicit source AND destination.
[ -n "$EVIDENCE_SRC" ]  || die "EVIDENCE_SRC is empty — set the source bucket/prefix."
[ -n "$EVIDENCE_DEST" ] || die "EVIDENCE_DEST is empty — set the off-site bucket/prefix."
[ "$EVIDENCE_SRC" != "$EVIDENCE_DEST" ] || die "SRC and DEST are identical — refusing."

if [ "$APPLY" = "1" ]; then
  MODE="APPLY (will copy objects)"
else
  MODE="DRY-RUN (no changes; set APPLY=1 to sync)"
fi
echo "Evidence backup — $MODE"
echo "  source:      $EVIDENCE_SRC"
echo "  destination: $EVIDENCE_DEST"

# --- Choose a tool: prefer aws-cli, fall back to rclone ---------------------
# NOTE: this is a SKELETON. Pick ONE tool for your environment and confirm the
# flags against its current docs before relying on it in production.
if command -v aws >/dev/null 2>&1; then
  echo "Using: aws s3 sync"
  # 'aws s3 sync' copies new/changed objects; it does NOT delete on the dest
  # unless --delete is given (we deliberately DO NOT pass --delete, so the
  # off-site copy is additive and versioning preserves history).
  AWS_ARGS=(s3 sync "$EVIDENCE_SRC" "$EVIDENCE_DEST" --only-show-errors)
  if [ "$APPLY" != "1" ]; then
    AWS_ARGS+=(--dryrun)
  fi
  # Credentials come from the AWS credential chain / AWS_PROFILE — never here.
  aws "${AWS_ARGS[@]}"

elif command -v rclone >/dev/null 2>&1; then
  echo "Using: rclone copy"
  # 'rclone copy' does not delete from dest. Configure the remotes in your
  # rclone config (RCLONE_CONFIG) — never embed credentials here.
  RCLONE_ARGS=(copy "$EVIDENCE_SRC" "$EVIDENCE_DEST")
  if [ "$APPLY" != "1" ]; then
    RCLONE_ARGS+=(--dry-run)
  fi
  rclone "${RCLONE_ARGS[@]}"

else
  die "Neither 'aws' nor 'rclone' found on PATH — install one and configure its credentials/profile."
fi

echo "Evidence backup step complete ($MODE)."

# ---------------------------------------------------------------------------
# REMINDERS (comments only):
#   * Verify the destination has VERSIONING on — this script relies on it for
#     recoverability, it does not create it.
#   * Periodically TEST that objects can be listed/fetched from the off-site
#     copy and match DB references (see the reconcile CLI, dry-run).
#   * Keep DB + evidence backups paired for a coherent recovery point.
# ---------------------------------------------------------------------------
