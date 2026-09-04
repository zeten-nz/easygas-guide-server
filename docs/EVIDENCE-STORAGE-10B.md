# Phase 10B — Evidence & Object-Storage Integrity

Guarantees that a photo or customer signature can never count as valid evidence
unless its file has actually been written to object storage and verified.

## Evidence state machine

Every mandatory evidence file (`job_photos`, `customer_signatures`) carries an
explicit lifecycle. **Only READY evidence counts** toward checklist step
completion and job completion.

| State   | Meaning                                                        | Counts? |
|---------|---------------------------------------------------------------|---------|
| PENDING | Metadata registered; object write not yet confirmed           | No      |
| READY   | Object written AND storage metadata (size) verified           | Yes     |
| FAILED  | Write failed, superseded by workflow change, or reconciliation found it missing/corrupt | No |

### Transition table

| From    | To     | Trigger                                                              |
|---------|--------|---------------------------------------------------------------------|
| —       | PENDING| Upload TX1: validated + registered under the job/step lock          |
| PENDING | READY  | Upload TX2: object written+verified, step/attempt/cycle still valid |
| PENDING | FAILED | Storage write error, size mismatch, or workflow moved on (SUPERSEDED); or reconciliation STALE |
| READY   | FAILED | Reconciliation found the object MISSING or size MISMATCH            |

READY and FAILED are terminal for a given row (evidence is immutable; a new
attempt/cycle creates a new row). Historical rows are never deleted.

## Upload ordering (two transactions around the storage write)

A DB transaction can never span object storage, so the write sits **between**
two transactions:

1. Validate: magic-byte type + pixel-dimension bound + size; compute SHA-256
   from the actual bytes; generate a server-only object key.
2. **TX1** — lock job + step; re-check workable state / step PENDING / attempt
   (and, for signatures, the current cycle + completed checklist + no existing
   READY/PENDING for the cycle); INSERT the row as **PENDING**; audit
   `PHOTO_UPLOAD_STARTED` / `SIGNATURE_UPLOAD_STARTED`.
3. **PUT** — write the object; then `stat()` it and verify the stored size.
4. **TX2** — lock job + step again; if the job is still workable and the step is
   still PENDING at the **same attempt** (signature: same cycle), flip
   PENDING→**READY** (+`ready_at`) and audit `PHOTO_UPLOAD_READY` /
   `CUSTOMER_SIGNED`. Otherwise mark **FAILED(SUPERSEDED)**, delete the just-
   written object, and return 409.
5. Return 201 only after the READY commit.

### Invariants this preserves

- Completion counts only READY → a crash between TX1 and TX2 leaves a PENDING
  row that never counts; reconciliation later marks it FAILED(STALE).
- **There is never valid metadata pointing at a missing object.** A storage
  failure or size mismatch marks the row FAILED (502 to the client); nothing
  is READY.
- A DB failure after the object write may leave an orphan object, but never
  valid metadata → reconciliation detects and reports it. The recoverable
  object is only deleted after we record (FAILED) what happened.
- Attempt-1 evidence can never satisfy attempt 2, and pre-reopen (cycle N)
  evidence can never satisfy cycle N+1 — TX2 re-checks attempt/cycle.
- Concurrency: job + step row locks in both transactions serialize uploads
  against complete-step / close / redo / cancel / reopen.

## Customer signature integrity (§23)

A signature is bound to `job_id`, the job's **completion cycle**, `customer_id`
(server-derived), the file **SHA-256**, and its signed timestamp. Completion
requires a **READY** signature for the **current cycle**. On reopen the job's
`cycle` advances and the prior READY signature is marked `superseded_at`
(kept in history, `SIGNATURE_SUPERSEDED` audited) — so the corrected work must
be re-signed before it can be completed again. Signatures are never deleted.

## Hash & metadata verification strategy

- **Upload:** SHA-256 computed from the received bytes; size + detected type
  from server inspection; `stat()` after write confirms existence and size
  before READY. (A full hash re-read on every upload is avoided — the write is
  immediately followed by a size-verifying stat.)
- **Completion/read:** gates trust the READY state (set only after the stat
  check). Downloads stream from storage and 404 cleanly if the object is gone.
- **Periodic:** `npm run reconcile` does the deeper DB↔storage comparison
  (existence + size; hash comparison would require a full read and is left to a
  future scheduled deep scan — documented risk).

## Reconciliation

```
npm run reconcile            # dry-run: report only, never mutates, never deletes
npm run reconcile -- --fix   # mark missing/corrupt READY rows + stale PENDING FAILED
npm run reconcile -- --json  # machine-readable
```

Findings: `MISSING` (READY row, object absent), `MISMATCH` (stored size ≠
recorded), `STALE` (PENDING older than 15 min — an interrupted upload).
`--fix` transitions those rows to FAILED (so they stop counting) and audits
`EVIDENCE_INTEGRITY_FAILURE`. **It never deletes storage objects.** Dry-run
exits non-zero when findings remain, for CI/alerting.

## Storage providers

`StorageProvider` contract: `put` (returns verified `stat`), `getStream`,
`stat` (HEAD; null when absent), `exists`, `delete`. Native errors are
normalized to `StorageError` (`NOT_FOUND | TIMEOUT | ACCESS_DENIED |
INVALID_KEY | IO`) so no provider detail reaches the app or clients. Object
keys are always server-generated; traversal/absolute keys are rejected.

- **local** (`LocalStorageProvider`) — development & tests, files under
  `STORAGE_LOCAL_DIR`, resolved strictly inside the root. Never served
  statically.
- **s3** (`S3StorageProvider`, AWS SDK v3) — AWS S3 or any S3-compatible
  service (MinIO). The bucket must be **private**; evidence is served only
  through the authorized backend streaming endpoints. Optional server-side
  encryption. Tests use an in-memory fake client (no real AWS).

Production **refuses** `STORAGE_PROVIDER=local` unless
`ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true` (documented emergency override).

## Environment variables (added in 10B)

| Variable | Default | Purpose |
|---|---|---|
| `STORAGE_PROVIDER` | `local` | `local` or `s3` |
| `ALLOW_LOCAL_STORAGE_IN_PRODUCTION` | (unset) | `true` to allow local in production (emergency) |
| `S3_BUCKET` | — | Bucket name (required for s3) |
| `S3_REGION` | — | Region (required for s3) |
| `S3_ENDPOINT` | — | Optional for AWS; required for MinIO |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO / path-style |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | Explicit creds; else standard AWS chain |
| `S3_SERVER_SIDE_ENCRYPTION` | — | e.g. `AES256` or `aws:kms` |

## Upload limits

- Photos: 10 MB, ≤10 READY/PENDING per step per attempt; JPEG/PNG/WebP only.
- Signatures: 5 MB; JPEG/PNG/WebP only.
- Images: ≤25 MP total, ≤12 000 px per side (decompression-bomb guard), read
  from the file header without decoding.
- Download headers: correct `Content-Type`, `Content-Length`,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` with a
  synthetic filename (never the internal key/path).

## Retry behavior

Storage/network failures (502) are retryable — the file was never accepted, so
resending is safe. Validation rejections (wrong type / too large) are permanent
until a different file is chosen. The client marks a photo/signature successful
only after the server returns READY (201), preserves unsent input on failure,
and disables the control while an upload is in flight.

## Migration & deployment

- Migration `20260816000019_evidence_storage_states` adds the lifecycle
  columns, `jobs.cycle`, and the signature `cycle`; replaces the
  one-signature-per-job UNIQUE with per-cycle indexing; **backfills all existing
  rows to READY** (see the backfill assumption in the migration header). Full
  down/up rollback is tested. Take a DB backup before applying, as with any
  schema change.
- Deploy order: apply the migration, deploy the server, then the client (the
  client's only change is upload UX; it stays compatible with the old server).
- After deploy, run `npm run reconcile` (dry-run) to confirm the READY backfill
  matches storage.

## Remaining risks (not solved in 10B)

- **EXIF stripping** and **malware/AV scanning** of uploads are not implemented.
- **Full per-object hash reconciliation** is not run automatically (only size +
  existence); a scheduled deep scan is future work.
- **Storage-side orphan sweep** (objects with no DB row) is not automated;
  reconciliation focuses on the DB→storage direction.
