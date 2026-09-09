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
→ no row). **Always take, and restore, the DB backup and the evidence backup as
a consistent pair**, scheduled close together (see `deploy/crontab.example`) and
treated as one recovery point. After a restore, `npm run reconcile` (dry-run)
tells you whether the pair is coherent.

**Redis is NOT a primary store** and does not need a data backup — see §4.

---

## 1. MySQL backup

Script: `scripts/backup-mysql.sh` (POSIX bash). It runs
`mysqldump --single-transaction --routines --triggers --set-gtid-purged=OFF`,
gzips to `BACKUP_DIR/<DB_NAME>-YYYYmmdd-HHMMSS.sql.gz`, refuses to run without
`DB_NAME`, never prints the password (temp `--defaults-extra-file`, 0600,
removed by a trap), and prints only the output filename + size.

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
sync. Requires `EVIDENCE_SRC` and `EVIDENCE_DEST`; uses the AWS credential chain
/ rclone remote (**never** embeds credentials); does **not** delete from the
source.

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

> **Dump-context hazard (guarded).** A dump made with `mysqldump --databases`
> or `--all-databases` embeds `CREATE DATABASE` + `USE <db>;`. Piped into
> `mysql <target>`, those `USE` lines silently redirect every statement to the
> dump's *own* database, ignoring `RESTORE_TARGET_DB` — which would bypass the
> `_test` and `FORCE_PROD_RESTORE` guards (a dump of `easygas` could overwrite
> `easygas` even with `RESTORE_TARGET_DB=easygas_restore_test`). `backup-mysql.sh`
> dumps a **single database positionally** and emits no such lines. The restore
> script now **refuses (fail closed) any dump containing `CREATE DATABASE`/`USE`**
> and additionally passes `mysql --one-database` as defense-in-depth. Never
> restore a `--databases` dump through this path; re-dump single-DB or strip the
> `CREATE DATABASE`/`USE` lines first.

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
1. **Migrations:** `npm run migrate:status` (and `npm run migrate` if behind).
2. **Audit chain:** `npm run audit:verify` — the tamper-evident hash chain must
   verify (added by another Phase 10F contributor; confirm the exact script
   name). A failure means tampering/corruption — do not put the DB into service.
3. **Evidence reconciliation:** `npm run reconcile` (dry-run) — confirms DB
   references and objects match (the pair is coherent). Investigate before any
   `--apply`.
4. **Completion snapshots readable / active risk policy:** `npm run risk-policy`
   and spot-check a completion snapshot read.
5. **Readiness:** start the app against the restored DB and
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
> full DB import + evidence availability + verification takes on your hardware —
> **measure it during the drill and record it above.**

---

## 8. Disposable LOCAL / TEST restore drill

Practice restores regularly against a **throwaway `*_test` database** so the
`_test` fail-closed guard (Phase 10A, `tests/helpers/test-env.ts`) and the
restore script's own non-`_test` guard both apply — you cannot accidentally
overwrite production.

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
