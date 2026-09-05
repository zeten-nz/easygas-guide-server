# Audit Integrity — Phase 10F

Tamper-evident hash chaining over the `audit_logs` table. This document describes the
chain model, its scope, how legacy rows are treated, how to verify a chain, the concurrency
model, the one documented limitation you must anchor against, and the recommended production
database grants.

> **Read this first (the honest limitation):** the chain makes tampering *detectable* by
> anyone who can re-derive the hashes, but a database administrator who can rewrite **both**
> the rows **and** the stored hashes/heads can produce a self-consistent forged chain. The
> only real defense against that is anchoring checkpoints **off-server** (see
> [External anchoring](#external-anchoring-the-only-defense-against-a-full-db-rewrite)). Do
> not claim tamper-*proof*; claim tamper-*evident, with off-server anchoring*.

---

## 1. What was added

| Object | Type | Purpose |
|---|---|---|
| `audit_logs.chain_id` | `VARCHAR(10)` | The chain a row belongs to — a UTC calendar day, `YYYY-MM-DD`. `NULL` for pre-migration rows. |
| `audit_logs.chain_seq` | `bigint` | Monotonic sequence **within a chain**, starting at 1. |
| `audit_logs.prev_hash` | `char(64)` | The previous entry's `entry_hash` (or the per-day genesis hash for `chain_seq = 1`). |
| `audit_logs.entry_hash` | `char(64)` | SHA-256 over the deterministic canonical serialization of the row (see below). |
| `audit_chain_heads` | table | One row per chain (`chain_id` PK, `head_hash`, `head_seq`, `updated_at`). The **lock target** that serializes appends within a day. |
| `audit_chain_checkpoints` | table | Exportable checkpoints: the legacy-boundary genesis checkpoint, plus per-chain head snapshots written by `audit:verify --checkpoint`. Intended for **off-server anchoring**. |
| `audit_logs_no_update` | `BEFORE UPDATE` trigger | Makes `audit_logs` rows non-updatable through the application DB credential (`SIGNAL SQLSTATE '45000'`). |

Migration: **`20260907000002_audit_log_integrity`** (reversible).

---

## 2. Chain scope — per-UTC-day

Each chain covers **one UTC calendar day** (`chain_id = 'YYYY-MM-DD'`). This bounds each
chain to a partition that stays small enough to verify quickly and paginate, and it means
appends on different days never contend for the same lock.

```
chain_id = 2026-09-07          chain_id = 2026-09-08
  seq 1  ─prev→ genesis(day)     seq 1  ─prev→ genesis(day)
  seq 2  ─prev→ hash(seq1)       seq 2  ─prev→ hash(seq1)
  seq 3  ─prev→ hash(seq2)       ...
  ...                            (independent chain)
```

The first entry of a day links to a deterministic **per-day genesis hash** (not to the
previous day's head). Chains are therefore independent per day; verification runs per chain.

---

## 3. How an entry is appended (`logAudit`)

Every audited write goes through `logAudit`, which runs **inside the caller's transaction**
and is acquired as the transaction's **last lock** (audit is always the last thing locked, so
it can never deadlock against business-row locks):

1. `INSERT ... ON DUPLICATE KEY` to ensure the day's `audit_chain_heads` row exists.
2. `SELECT ... FOR UPDATE` on that head row — serializes appends **within the day** only.
3. Compute `prev_hash` = the current head's hash (or the per-day genesis hash for the first entry).
4. Compute `chain_seq` = `head_seq + 1`.
5. Compute the deterministic `entry_hash`.
6. `INSERT` the audit row (with `chain_id`, `chain_seq`, `prev_hash`, `entry_hash`).
7. Advance the head row (`head_hash`, `head_seq`, `updated_at`).

All of the above commits atomically with the business change. If the caller's transaction
rolls back, no audit row and no head advance survive.

---

## 4. What `entry_hash` covers

`entry_hash = sha256(canonical)` where `canonical` is a **deterministic, sorted-key**
serialization of exactly these fields:

```
version, chain_id, chain_seq, prev_hash,
user_id, action, entity_type, entity_id,
old_value, new_value, ip, user_agent
```

Notes:

- **`created_at` is intentionally NOT hashed.** The ordering authority is `chain_seq`, not the
  timestamp; `created_at` is informational. (Its precision was independently upgraded to
  microseconds — see `TIMESTAMP-PRECISION` in the Phase 10F migration set — but it remains a
  non-authoritative field.)
- **No secrets are in the payload by existing design.** Audit rows already never contain a raw
  signature, OTP, token, GPS coordinate, or other secret: GPS rows store only accuracy/purpose,
  signatures store only a SHA-256 hash. The chain hashes only what the row already holds — it
  does not introduce any new sensitive data.
- The serialization is canonical (keys sorted, stable encoding) so the same logical row always
  hashes to the same value, on insert and on re-verification.

---

## 5. Legacy honesty — pre-migration rows are NOT retro-chained

Rows that existed **before** the migration have `chain_id = NULL` and are **not** part of any
chain. We deliberately do **not** back-fill hashes onto them: a hash computed after the fact
attests nothing about a row's origin.

Instead, the migration writes a **genesis checkpoint** into `audit_chain_checkpoints` recording
the legacy boundary (the maximum existing `audit_logs.id` at migration time) with a note that
those rows are **unchained / origin-not-attested**.

> Do **not** claim historical integrity for pre-migration rows. Integrity guarantees begin at
> the first chained row after the boundary.

---

## 6. Append-only enforcement

- **DB trigger:** `audit_logs_no_update` (BEFORE UPDATE) raises `SIGNAL SQLSTATE '45000'`, so
  the application DB credential cannot UPDATE an audit row.
- **Application:** no service ever issues UPDATE or DELETE against `audit_logs`.
- **Deletion:** a deleted row leaves a **gap in `chain_seq`**, which verification detects. At the
  DB level deletion is **not blocked in tests** (test cleanups delete rows), and the trigger only
  covers UPDATE. In production, deletion is prevented by **restricted GRANTs** (see §9) plus the
  trigger — together they make the app credential incapable of altering history, and any
  out-of-band deletion is still detectable by the chain.

---

## 7. Verification — `npm run audit:verify`

Read-only CLI (`src/modules/audit/audit-verify.cli.ts`). It re-derives every chained entry's
hash and checks three independent properties, **per chain**, bounded/paginated:

| Check | Detects |
|---|---|
| `entry_hash` recomputes and matches | Content tampering (any hashed field changed) |
| `prev_hash` links to the prior entry's `entry_hash` | Reordering / substitution |
| `chain_seq` is contiguous from 1 | Deletion (a gap) |

```bash
# Verify the whole (chained) history, human-readable
npm run audit:verify

# Machine-readable output
npm run audit:verify -- --json

# ALSO write exportable per-chain checkpoint rows for off-server anchoring
npm run audit:verify -- --checkpoint "nightly anchor 2026-09-07"
```

**Exit codes:** `0` = OK, `2` = integrity failure (tamper/gap detected), `1` = error.

`--checkpoint "<note>"` writes per-chain head hash/seq rows into `audit_chain_checkpoints` so you
can export them off-server. This is the same table the migration's genesis checkpoint lives in.

---

## 8. Concurrency

- The `audit_chain_heads` `FOR UPDATE` lock serializes **only concurrent same-day audit appends**,
  which are low-volume. It does **not** serialize the whole application.
- It is acquired as the transaction's **last** lock → **deadlock-free** with respect to business
  row locks.
- Different days use different head rows and **never contend**.

Tested in `tests/audit-integrity.e2e.ts`: 15 concurrent audited actions advance the day's head by
**exactly 15**, with **no duplicate `chain_seq`**.

---

## 9. Recommended production database GRANTs

Give the **application** DB user only what it needs on `audit_logs` — no UPDATE, no DELETE:

```sql
-- Application credential: append + read audit rows only.
GRANT INSERT, SELECT ON easygas.audit_logs TO 'easygas_app'@'%';
-- The app also needs to maintain the head row (INSERT ... ON DUPLICATE KEY + advance):
GRANT INSERT, SELECT, UPDATE ON easygas.audit_chain_heads TO 'easygas_app'@'%';
-- (Grant the app its normal privileges on the other business tables as usual.)
```

Rationale: with no `UPDATE`/`DELETE` on `audit_logs`, the app credential **cannot** rewrite or
remove history; the trigger backs up the UPDATE restriction; any deletion performed with a more
privileged credential still shows up as a `chain_seq` gap during verification.

> `audit_chain_heads` needs `UPDATE` because appends advance the head. That is expected and does
> not weaken the audit rows themselves — the rows remain append-only.

---

## 10. External anchoring — the only defense against a full DB rewrite

The chain is only as trustworthy as the hashes it is checked against. An administrator who can
rewrite the audit rows **and** the `entry_hash`/`prev_hash` values **and** the
`audit_chain_heads`/`audit_chain_checkpoints` tables can produce a forged chain that verifies
cleanly on that server.

**Mitigation — anchor checkpoints off-server:**

1. Regularly run `npm run audit:verify -- --checkpoint "<note>"` (see the Operations Runbook for
   the scheduled job) to snapshot each chain's head hash + seq into `audit_chain_checkpoints`.
2. **Export** those checkpoint rows (or the `--json` verify output) to **immutable, off-server
   storage** you control independently of the DB administrator — e.g. an append-only object-store
   bucket, a WORM log, or a third party.
3. To audit later, re-run verification and confirm the current heads still match the **off-server**
   checkpoint values. A forged in-DB chain cannot match an anchor the forger never controlled.

State this limitation honestly in any compliance conversation: the system is
**tamper-evident with off-server anchoring**, not tamper-proof against a fully privileged DBA.

---

## 11. Tests — `npm run test:audit`

`tests/audit-integrity.e2e.ts`, 6 tests, all passing:

1. New entries are chained and their hashes recompute correctly.
2. Concurrency: 15 concurrent audited actions → head advances by exactly 15, no duplicate seq.
3. Append-only: an UPDATE to an audit row is blocked by the trigger.
4. A good chain verifies clean (exit 0).
5. Content tamper is detected (exit 2).
6. Deletion (a `chain_seq` gap) is detected (exit 2).
