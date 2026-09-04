# Phase 10B — Evidence & Object-Storage Integrity

Guarantees that a photo or customer signature can never count as valid evidence
unless its file has actually been written to object storage and verified.

## Evidence state machine

Every mandatory evidence file (`job_photos`, `customer_signatures`) carries an
explicit lifecycle. **Only READY evidence counts** toward checklist step
completion and job completion.

| State      | Meaning                                                                   | Counts? |
|------------|---------------------------------------------------------------------------|---------|
| PENDING    | A Phase 10B upload in flight; object write not yet confirmed               | No      |
| UNVERIFIED | A pre-Phase-10B legacy row; object never checked against its metadata      | No      |
| READY      | Object written AND verified against its recorded size (+sha256 at upload)  | Yes     |
| FAILED     | Write failed, superseded, stale, or verification found it missing/altered  | No      |

The `status` column is the single source of provenance: `UNVERIFIED` = legacy
and never verified, `PENDING` = a 10B upload in progress, `READY` = an object
actually verified (its `ready_at` is set only on that transition). Nothing
infers "verified" from `ready_at` or from the mere existence of a row.

### Transition table

| From       | To     | Trigger                                                                         |
|------------|--------|---------------------------------------------------------------------------------|
| —          | PENDING| Upload TX1: validated + registered under the job/step lock                      |
| PENDING    | READY  | Upload TX2: object written+size-verified, step/attempt/cycle still valid        |
| PENDING    | FAILED | Storage write error, size mismatch, workflow moved on (SUPERSEDED), or reconciliation STALE |
| UNVERIFIED | READY  | Reconciliation **deep** verify: object read, size + sha256 (+type) all match    |
| UNVERIFIED | FAILED | Reconciliation deep verify: object missing / size / sha256 / type mismatch      |
| READY      | FAILED | Reconciliation found the object MISSING or size/sha256 MISMATCH                  |

READY and FAILED are terminal for a given row (evidence is immutable; a new
attempt/cycle creates a new row). `UNVERIFIED` is only ever left by a
reconciliation deep-verify run — a transient storage error leaves it untouched
so the run can be retried. Historical rows are never deleted.

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

### What is actually guaranteed

This is the precise guarantee — the implementation does **not** claim that valid
metadata can never point at a missing object *forever* (an object can be lost or
altered externally, e.g. bit rot or an accidental delete, after it is READY):

- **No evidence becomes READY before its object is written and verified.** A row
  reaches READY only after the object is stored and its size confirmed (with the
  sha256 computed from the received bytes at upload). A storage failure or size
  mismatch marks the row FAILED (502 to the client); nothing is READY.
- **Workflow completion accepts only READY evidence** *and* re-checks the object
  at completion time (see [Completion-time verification](#completion-time-verification)):
  a photo/signature whose object went missing or changed size blocks the close.
- **Later external loss or corruption is detected**, not prevented — at
  completion time (existence + size) and by scheduled reconciliation
  (existence + size, and full sha256 with `--deep`).
- A DB failure after the object write may leave an orphan object, but never
  valid metadata pointing at a missing object at the moment it is created;
  reconciliation detects and reports orphans/failures. A recoverable object is
  only deleted after we record (FAILED) what happened.
- Legacy rows are **UNVERIFIED**, never READY, until a deep verification run
  proves the object matches — a DB row is not treated as evidence on its own.
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

The balance is: verify the full hash where it is affordable (once, at upload,
and in scheduled deep runs), and use the cheaper existence+size check on the hot
path (completion), because hashing every object on every close would read the
whole file each time.

- **Upload:** SHA-256 computed from the received bytes and stored; size +
  detected image type from server inspection; `stat()` after write confirms
  existence and size before the row becomes READY.
- **Completion:** the DB gate counts only READY rows, and the close path then
  re-stats each relevant object to confirm it still exists at its recorded size
  (existence + size, not a full re-hash — see below). Downloads stream from
  storage and 404 cleanly if the object is gone.
- **Legacy verification / periodic deep scan:** `npm run reconcile --deep`
  reads each object in full, recomputes its SHA-256, and compares size + hash
  (+ detected type). This is the only path that promotes an UNVERIFIED legacy
  row to READY, and the way READY rows are audited against their recorded hash.

## Completion-time verification

`validateJobCompletion` is the DB-truth gate (counts only `status = READY`) and
is used by the readiness endpoint, so it does no storage I/O and stays cheap.
The authoritative close path (`closeJob`, `confirmQuality`) additionally calls
`assertReadyEvidenceObjects(jobId)` **before** taking the write lock:

- It stats every READY object the gate relies on — required photos of the
  relevant attempt + the current-cycle signature — and confirms each exists at
  its recorded size.
- On any missing object, size mismatch, stat timeout or provider error it
  **fails closed** with a stable `502 EVIDENCE_UNVERIFIABLE`; the job is not
  completed. No provider detail reaches the client.
- It runs outside the transaction (no storage I/O under a row lock) and **never
  mutates** evidence status — turning a lost READY object into FAILED is
  reconciliation's deliberate, audited job, not a side effect of a read.
- It verifies existence + size, not a full re-hash, to keep close latency
  bounded for the current small checklist size; the sha256 was verified at
  upload and is re-verified by scheduled deep reconciliation.

## Reconciliation

```
npm run reconcile                     # dry-run: report only, never mutates, never deletes
npm run reconcile -- --deep           # dry-run, full sha256 re-hash of READY rows too
npm run reconcile -- --apply          # apply transitions (alias: --fix)
npm run reconcile -- --apply --deep   # apply, with full-hash READY verification
npm run reconcile -- --concurrency=8  # bound parallel object reads (default 4)
npm run reconcile -- --json           # machine-readable
```

Three passes per table, with **bounded concurrency**:

1. **Legacy** (`UNVERIFIED`) — always deep: the object is read, its SHA-256
   recomputed and compared with the recorded size + hash (+ detected type). A
   full match promotes `UNVERIFIED → READY` (audited `EVIDENCE_VERIFIED`); a
   missing/short/altered object → `FAILED` (audited `EVIDENCE_INTEGRITY_FAILURE`).
2. **READY integrity** — existence + size by default; with `--deep`, full
   sha256 too. Missing/mismatch → `FAILED`.
3. **Stale PENDING** — a PENDING upload older than 15 min → `FAILED(STALE)`.
   `UNVERIFIED` rows are never touched by this sweep.

Per-record results are reported (`table #id (job) — reason → transition`), never
storage keys or paths. **It never deletes storage objects.** A transient storage
error leaves the row unchanged (`ERROR`) so the run is safe to repeat.

- **Idempotent & resumable:** every transition runs in its own transaction and
  only fires when the row is still in the expected source state, so an
  interrupted run can simply be re-run and a repeat run changes nothing.
- **Exit code:** `0` when clean; `2` when invalid or unverifiable evidence
  remains (missing / mismatch / stale / transient error) — in dry-run these are
  unaddressed; in apply mode they have been recorded FAILED (or left for retry)
  and need operator attention before active jobs rely on them; `1` if the run
  itself failed. Suitable for CI/alerting.

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

Migration `20260816000019_evidence_storage_states` adds the lifecycle columns,
`jobs.cycle`, and the signature `cycle`; replaces the one-signature-per-job
UNIQUE with per-cycle indexing; and **backfills every existing evidence row to
`UNVERIFIED`, not READY** — a pre-existing DB row is not proof the object is
present and unaltered, so legacy evidence stays non-valid until a deep
verification run confirms it. Full down/up rollback is tested.

**A migration temporarily makes historical evidence non-READY.** Until the
verification run in step 7 below completes, jobs whose completion depends on
legacy evidence will not close. Plan the window accordingly. This is deliberate:
it is the mechanism that stops an unverified legacy object from silently
authorizing a completion.

### Maintenance-safe deployment sequence

1. **Back up** the database *and* the evidence object storage.
2. **Stop or drain write traffic** (maintenance window) so no uploads/closes run
   during the migration and verification.
3. **Deploy the compatible server code** (it reads the new columns).
4. **Run the migration** (`npm run migrate`).
5. **Run reconciliation in dry-run + deep mode**
   (`npm run reconcile -- --deep`) to see what legacy verification will do.
6. **Review the results** — expect legacy rows reported for verification;
   investigate any MISSING/MISMATCH.
7. **Run the explicit apply + deep pass** (`npm run reconcile -- --apply --deep`)
   to promote verified legacy rows to READY and mark missing/altered ones FAILED.
8. **Confirm no unresolved legacy records remain for active jobs** (exit code 0,
   or triage the reported FAILED/ERROR records) before reopening traffic.
9. **Start / restore server traffic.**
10. **Deploy the frontend** (its only change is upload UX; it stays compatible
    with the old server).
11. **Smoke-test** an upload, a completion, and a signature capture.

Rebuilding a disposable local/test database instead of migrating in place is
fine and is how the down/up rollback is verified.

## Remaining risks (not solved in 10B)

- **EXIF stripping** and **malware/AV scanning** of uploads are not implemented.
- **Full per-object hash reconciliation** exists (`reconcile --deep`) but is not
  yet *scheduled* — it must be run manually or wired into a cron/CI job.
  Completion-time verification checks existence + size, not the full hash.
- **Storage-side orphan sweep** (objects with no DB row) is not automated;
  reconciliation focuses on the DB→storage direction.
