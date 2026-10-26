# Phase 10F — Backup, Restore & Disaster Recovery Runbook

Operational runbook for backing up and restoring the EASY GAS safety-critical
system. It covers the MySQL database, the S3/MinIO evidence store, Redis data
classification, encryption/retention/off-site policy, the restore procedure and
its verification, RPO/RTO as **business decisions**, and a disposable local
restore **drill**.

> **This document deploys nothing and contains no secrets.** All commands read
> configuration from the environment. Everything actually *destructive* is
> gated behind explicit flags (see `scripts/restore-mysql.sh`).

---

## 0. What must be backed up — and why as a *pair*

The system has **two** stateful stores that reference each other:

| Store | Contents | Backup artifact |
|---|---|---|
| **MySQL** | users, jobs, checklists, risks, completion snapshots, **audit log**, `sms_outbox`, session/OTP rows, and **references to evidence objects** | `scripts/backup-mysql.sh` |
| **Object storage (S3/MinIO)** | evidence **objects**: customer signatures, step photos, completion artifacts | `scripts/backup-evidence.sh` |

The DB rows point at the evidence objects. Restoring one without the other
yields **dangling references** (DB row → missing object) or **orphans** (object
→ no row). The DB dump and the evidence copy run minutes apart, so they are **NOT
a transactionally consistent pair**. Safe recovery instead relies on **object
versioning** on both stores (so no referenced version is lost) plus a
**reconcile** at the chosen recovery point: restore the DB, ensure the evidence
versions for that point are present, then run `npm run reconcile` (dry-run) to
confirm the two are coherent and repair any dangling reference. Schedule the two
backups close together (see `deploy/crontab.example`), but treat versioning +
reconcile — not timing — as what makes a recovery point.

**Redis is NOT a primary store** and does not need a data backup — see §4.

---

## 1. MySQL backup

Script: `scripts/backup-mysql.sh` (POSIX bash). It runs a **positional
single-database** dump (`mysqldump --single-transaction --routines --triggers
--events --no-tablespaces --set-gtid-purged=OFF <DB_NAME>` — never
`--databases`/`--all-databases`), gzips to
`BACKUP_DIR/<DB_NAME>-YYYYmmdd-HHMMSSZ.sql.gz`, and hardens the artifact end to
end: it checks **both** pipeline stages (mysqldump AND gzip, so a compressor or
disk-full failure never reports success), writes to a private temp file and only
then **atomically publishes** it, verifies gzip integrity + the `Dump completed
on` marker before publishing, **refuses to overwrite** an existing file,
**self-locks** (`flock`) so two runs never overlap, and records a `.sha256`
sidecar + a `.manifest` (routines/triggers/events flags). It refuses to run
without `DB_NAME`, writes everything mode 600, never prints the password (temp
`--defaults-extra-file`, 0600, removed by a trap), and prints the final filename,
size and sha256.

```bash
DB_USER=<user> DB_PASSWORD=<pw> DB_NAME=easygas \
  BACKUP_DIR=/var/backups/easygas/mysql \
  bash scripts/backup-mysql.sh
```

- `--single-transaction` gives an InnoDB-consistent snapshot **without locking
  writers**.
- The dump includes the **audit log** table; its hash chain is verified after
  restore (§6).
- `sms_outbox` rows are included but are short-lived; queued-but-unsent OTPs are
  not meaningful to restore later (an OTP that arrives late is cancelled by
  design).

### Point-in-time recovery (optional, tightens RPO)
`mysqldump` alone gives you **snapshot** RPO (≤ the backup interval). To recover
to an arbitrary moment, additionally enable **MySQL binary logs** and archive
them; restore = last full dump + replay binlogs to the target time. Decide this
against the RPO target in §7.

---

## 2. Evidence (S3/MinIO) backup & versioning

Script: `scripts/backup-evidence.sh`. Dry-run by default; `APPLY=1` performs the
copy. Choose **one tool explicitly** — `EVIDENCE_TOOL=aws` (default; `s3://`
URIs) or `EVIDENCE_TOOL=rclone` (`remote:bucket` syntax). aws-cli and rclone do
**not** share remote syntax, so the script refuses an `s3://` path under rclone
(and a `remote:` path under aws) — never feed `s3://` to rclone.
`DIRECTION=backup` (default) copies `EVIDENCE_SRC` → `EVIDENCE_DEST`;
`DIRECTION=restore` retrieves `EVIDENCE_DEST` → `EVIDENCE_RESTORE_TO` and verifies
the retrieved copy. It uses the AWS credential chain / rclone remote (**never**
embeds credentials) and does **not** delete from the source.

```bash
# dry-run
EVIDENCE_SRC=s3://easygas-evidence EVIDENCE_DEST=s3://easygas-evidence-dr \
  bash scripts/backup-evidence.sh
# apply
APPLY=1 EVIDENCE_SRC=s3://easygas-evidence EVIDENCE_DEST=s3://easygas-evidence-dr \
  bash scripts/backup-evidence.sh
```

**Bucket policy (both primary and off-site):**
- **Private** — evidence is sensitive; never publicly readable.
- **Versioning ENABLED** — the primary defense against accidental
  delete/overwrite (you can restore a previous object version in place). The
  off-site copy keeps history even if the primary is compromised.
- **Encryption at rest** (SSE — the app sets `S3_SERVER_SIDE_ENCRYPTION`).
- Ideally a **different account/region** for the off-site copy (blast-radius
  isolation).
- Consider **Object Lock / MFA-delete** on the off-site bucket for ransomware
  resistance.

---

## 3. Encryption at rest & off-server copy

- **MySQL dumps:** encrypt before/at write with `gpg` (see the comments in
  `backup-mysql.sh`) and store the key **off** the DB host. A plaintext dump is
  a full copy of all PII and audit data.
- **Evidence:** rely on bucket SSE plus the off-site versioned copy.
- **Off-server:** a backup that lives only on the source host does **not**
  survive host loss. Copy both artifacts off-box (the evidence sync already is;
  push the MySQL dump to a versioned bucket / remote host).

---

## 4. Redis data classification (what is safe to lose)

Redis is a **coordination / rate-limit** layer, **not** a source of truth. On a
total Redis loss:

| Redis data | Nature | Impact of loss |
|---|---|---|
| Rate-limit / abuse counters (`rl:*`) | Ephemeral, self-expiring | Counters reset — users briefly get a fresh window. Acceptable. |
| Any transient coordination keys | Ephemeral | Recomputed on demand. |
| **Sessions** | **NOT in Redis — sessions are DB-backed** | Redis loss ≠ session loss. |

**Sessions are stored in MySQL** (opaque token → SHA-256 in the DB), so a Redis
outage does **not** log anyone out. What Redis loss *does* mean: while Redis is
**down**, the fail-closed abuse controls (login / OTP / reset rate limiting)
**block** those flows by design (never silently disabled). So **do not back up
Redis data**; instead ensure Redis **availability** (TLS+auth, managed/HA).
Restoring Redis = just bring an empty Redis back up.

---

## 5. Retention

- **Backups:** define and enforce a retention schedule (e.g. keep N daily, M
  weekly), and **prune** old artifacts. Bucket versioning + lifecycle rules can
  automate off-site pruning.
- **In-app data retention** is separate and handled by `npm run cleanup`
  (sessions/OTP/terminal SMS rows) — see `deploy/crontab.example`. A restored
  DB simply resumes that schedule.

---

## 6. Restore procedure (DB) — DESTRUCTIVE, guarded

Script: `scripts/restore-mysql.sh`. **Defaults to dry-run.** To apply it needs
a dump argument, `RESTORE_TARGET_DB`, `CONFIRM_RESTORE=yes`, `APPLY=1`, and —
for a non-`_test` (production-shaped) target — `FORCE_PROD_RESTORE=yes` as well.

It is safe-by-construction:
- **Validate-before-mutate:** the whole compressed artifact is gzip-integrity-checked
  and decompressed to a validated temp file **first** — that temp is the exact file
  `mysql` then consumes, so the bytes validated are the bytes restored. If validation
  fails, no database is touched.
- **Provenance:** if a `<file>.sha256` sidecar is present it is verified (mismatch →
  refuse). There is deliberately **no flag that bypasses integrity validation.**
- **Target-id guard:** `RESTORE_TARGET_DB` must be a plain `[A-Za-z0-9_]` identifier,
  validated **before** it is ever interpolated into SQL.
- **Honest failure:** if `mysql` errors mid-import, the script warns the target may be
  in a **PARTIAL/inconsistent** state — do not use it until re-restored from a good artifact.

> **Dump-context hazard (guarded).** A dump made with `mysqldump --databases`
> or `--all-databases` embeds `CREATE DATABASE` + `USE <db>;`. Piped into
> `mysql <target>`, those `USE` lines silently redirect every statement to the
> dump's *own* database, ignoring `RESTORE_TARGET_DB` — which would bypass the
> `_test` and `FORCE_PROD_RESTORE` guards (a dump of `easygas` could overwrite
> `easygas` even with `RESTORE_TARGET_DB=easygas_restore_test`). `backup-mysql.sh`
> dumps a **single database positionally** and emits no such lines.
>
> The restore script runs a **fail-closed heuristic scan** that refuses any dump
> with line-anchored `CREATE DATABASE`/`USE` — including the `/*!NNNNN … */`
> executable-comment wrapper and leading-whitespace/case variants, i.e. every form
> the mysqldump family emits. **This scan is defense-in-depth — NOT a comprehensive
> SQL parser and NOT a security boundary**: a hand-crafted dump could still evade a
> line-anchored text scan (e.g. a `USE` placed after a `;` mid-line). The real
> guarantees are (a) **only ever restore dumps produced by `backup-mysql.sh`**
> (single-DB, positional, with no embedded `CREATE DATABASE`/`USE`) and (b) an
> **isolated, disposable target** (see §8). Never restore a `--databases` dump
> through this path; re-dump single-DB or strip the `CREATE DATABASE`/`USE` lines first.

```bash
# 1) DRY-RUN (prints the plan, changes nothing)
RESTORE_TARGET_DB=easygas_restore_test CONFIRM_RESTORE=yes \
  DB_USER=<u> DB_PASSWORD=<pw> \
  bash scripts/restore-mysql.sh /var/backups/easygas/mysql/easygas-YYYYmmdd-HHMMSS.sql.gz

# 2) APPLY (destructive overwrite of the target)
APPLY=1 RESTORE_TARGET_DB=easygas_restore_test CONFIRM_RESTORE=yes \
  DB_USER=<u> DB_PASSWORD=<pw> \
  bash scripts/restore-mysql.sh /var/backups/.../easygas-YYYYmmdd-HHMMSS.sql.gz
```

**Restore both stores as a pair:** restore the MySQL dump *and* ensure the
evidence objects for that recovery point are present (from the versioned off-site
bucket). Then run the verification checklist.

### Post-restore verification (the script prints this too)
1. **Migrations:** `npm run migrate:status` (and `npm run migrate` if behind) —
   this is **bookkeeping only**, not a full schema verification.
2. **Audit chain:** `npm run audit:verify` — verifies the **consistency** of the
   tamper-evident hash-chain links. A failure means tampering/corruption (do not
   put the DB into service). It is **not** proof that no historical rows were lost;
   completeness is a separate question.
3. **Evidence reconciliation:** `npm run reconcile` (dry-run) — confirms DB
   references and objects match (the recovery point is coherent). Investigate
   before any `--apply`.
4. **Completion snapshots readable / active risk policy:** `npm run risk-policy`
   and spot-check a completion snapshot read.
5. **Readiness:** start the app against the restored DB (on the PRIVATE port) and
   `curl -fsS http://127.0.0.1:4000/api/v1/ready` → expect HTTP 200
   `{"status":"ready"}` (503 = a dependency is down).

---

## 7. RPO / RTO — **business decisions (TBD by EasyGas)**

These are **not** guarantees invented here. They must be set by EasyGas
leadership against cost and risk, then this table filled in and the schedules in
`deploy/crontab.example` adjusted to meet them.

| Metric | Meaning | Value |
|---|---|---|
| **RPO** (Recovery Point Objective) | Max acceptable data loss window | **TBD** |
| **RTO** (Recovery Time Objective) | Max acceptable time to restore service | **TBD** |
| Backup frequency (DB) | Drives RPO | **TBD** (e.g. nightly; +binlogs for PITR) |
| Backup frequency (evidence) | Drives RPO | **TBD** |
| Retention (daily/weekly/monthly) | How far back you can restore | **TBD** |
| Off-site location | Region/account for DR copies | **TBD** |
| Restore-drill cadence | How often the drill (§8) is run | **TBD** |

> With the example nightly schedule, RPO is up to ~24h and RTO is however long a
> full DB import + evidence availability + verification takes on your hardware.
> **Measure it during the drill and record it above** — but a measured drill
> duration is an observation, **not** a promised RTO (the RTO target is a business
> decision, set independently of any single measurement).

---

## 8. Disposable restore drill

Practice restores regularly. **Run the drill against a SEPARATE, disposable MySQL
instance** with its own restricted credentials and no network path to
development/production. The `_test` suffix on `RESTORE_TARGET_DB` is only a
**fat-finger guard-rail** (it lets the restore proceed without
`FORCE_PROD_RESTORE`) — it is **NOT** an isolation boundary and does **not**
protect a shared privileged server where a mistake could still reach real data.
Real isolation comes from the disposable instance, not the name; point
`DB_HOST`/credentials at that instance.

```bash
# Restore last night's dump into a disposable *_test DB (no force flag needed
# because the name ends in _test):
APPLY=1 RESTORE_TARGET_DB=easygas_restore_test CONFIRM_RESTORE=yes \
  DB_USER=<u> DB_PASSWORD=<pw> \
  bash scripts/restore-mysql.sh /var/backups/.../easygas-YYYYmmdd-HHMMSS.sql.gz

# Then verify against that test DB (point env at it), e.g.:
DB_NAME=easygas_restore_test npm run migrate:status
DB_NAME=easygas_restore_test npm run audit:verify        # hash chain
DB_NAME=easygas_restore_test npm run reconcile           # dry-run
```

- Use a **copy** of evidence (or a read-only off-site copy) so the drill never
  mutates the real evidence store.
- **Time the drill** end-to-end and record RTO in §7.
- Tear the `*_test` database down afterwards (`npm run cleanup` is unrelated;
  just drop the disposable schema).

---

## 9. Quick reference

| Task | Command |
|---|---|
| DB backup | `BACKUP_DIR=... bash scripts/backup-mysql.sh` |
| Evidence backup (dry-run) | `EVIDENCE_SRC=... EVIDENCE_DEST=... bash scripts/backup-evidence.sh` |
| Evidence backup (apply) | `APPLY=1 EVIDENCE_SRC=... EVIDENCE_DEST=... bash scripts/backup-evidence.sh` |
| DB restore (dry-run) | `RESTORE_TARGET_DB=..._test CONFIRM_RESTORE=yes bash scripts/restore-mysql.sh dump.sql.gz` |
| DB restore (apply, test) | `APPLY=1 RESTORE_TARGET_DB=..._test CONFIRM_RESTORE=yes bash scripts/restore-mysql.sh dump.sql.gz` |
| Verify audit chain | `npm run audit:verify` |
| Verify evidence pair | `npm run reconcile` (dry-run) |
| Readiness | `curl -fsS http://127.0.0.1:4000/api/v1/ready` |
