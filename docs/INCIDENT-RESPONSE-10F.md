# Incident Response — Phase 10F

A concise, safety-first incident playbook. EASY GAS is a safety-critical system: when a dependency
is degraded the app **fails closed** on safety-relevant paths. This outline covers severity levels,
first steps, and per-scenario response.

> Cross-references: `OPERATIONS-RUNBOOK-10F.md` (readiness, processes, scheduled jobs),
> `AUDIT-INTEGRITY-10F.md` (chain verification/anchoring), `KEY-ROTATION-10F.md` (credential
> rotation), `BACKUP-RESTORE-10F.md` (restore).

---

## 1. Severity levels

| Sev | Definition | Examples |
|---|---|---|
| **SEV-1** | Safety integrity or data integrity at risk; or total outage | Audit-chain verification failure; evidence integrity failure; suspected data tampering; DB down |
| **SEV-2** | Major degradation, fail-closed protections active | Redis outage (auth/OTP limiters failing closed), storage unreachable, SMS worker stalled |
| **SEV-3** | Minor / partial degradation, no safety impact | Elevated latency, single non-critical check flapping |

Assume the higher severity until proven otherwise. Anything touching **audit or evidence integrity
is SEV-1**.

---

## 2. First steps (any incident)

1. **Assess reachability:** check `GET /api/v1/health` (process up?) and `GET /api/v1/ready`
   (dependencies OK?). A failing `/ready` names the failing check.
2. **Check metrics/dashboards:** `easygas_readiness_up`, `*_failures_total`, pool state, event-loop
   lag, outbox counts (see `OBSERVABILITY-10F.md`).
3. **Correlate in logs:** grab the `x-request-id` from the report/response and trace it through the
   pino logs (`pm2 logs`). Redaction keeps secrets/PII out of logs.
4. **Contain:** if an instance is unhealthy, take it **out of rotation** (it should already be
   not-ready). Do **not** disable safety checks to "get it working."
5. **Declare severity + start a timeline.** Record actions and timestamps.

---

## 3. Scenario playbooks

### 3.1 Audit-chain compromise (SEV-1)

Symptoms: `npm run audit:verify` exits non-zero (`2` = integrity failure), or the scheduled
verify alerted.

1. Run `npm run audit:verify -- --json` to see which chain/entry failed and the failure type
   (content tamper vs. `prev_hash` break vs. `chain_seq` gap/deletion).
2. **Compare against off-server checkpoints:** retrieve the anchored `audit_chain_checkpoints`
   exports and confirm whether the current heads match the off-server anchors. A mismatch against an
   anchor the attacker never controlled is strong evidence of tampering (see
   `AUDIT-INTEGRITY-10F.md` §10).
3. Treat as a potential intrusion: preserve evidence, review DB access, and initiate credential
   rotation (`KEY-ROTATION-10F.md`) — especially DB credentials.
4. Do not "repair" the chain. Investigate origin first; restore from a known-good backup pair only
   after root cause is understood.

### 3.2 Evidence integrity failure (SEV-1)

Symptoms: `easygas_storage_failures_total` rising, `EVIDENCE_UNVERIFIABLE`/`EVIDENCE_INTEGRITY_FAILURE`,
or completion refused with a 502.

1. Run reconciliation in dry-run first, then apply:
   ```bash
   npm run reconcile -- --deep            # review
   npm run reconcile -- --deep --apply    # fix (promotes verified, marks missing/mismatch FAILED)
   ```
2. Reconcile **never deletes**; exit `2` means invalid/unverifiable evidence remains — investigate
   the object store (missing objects, credential/bucket issues) before re-running.
3. If objects are lost, restore from the evidence backup that pairs with the DB backup (consistent
   recovery point) — see `BACKUP-RESTORE-10F.md`.

### 3.3 Credential leak (SEV-1)

1. Identify the leaked secret and its blast radius.
2. **Rotate immediately** per `KEY-ROTATION-10F.md` (APP_KEY, DB, Redis, S3, Eskiz, `METRICS_TOKEN`,
   `SERVER_REPO_TOKEN`). Mind APP_KEY's side effects (in-flight CSRF invalidation; **drain the SMS
   outbox first** — encrypted payloads become undecryptable after rotation).
3. Revoke sessions if user credentials are implicated; review audit logs (and off-server anchors)
   for misuse.

### 3.4 Redis outage (SEV-2)

Fail-closed behavior: **auth / OTP / reset limiters fail CLOSED** (requests are rejected rather than
run unlimited); general/API limiters fail **open**. `/ready` reports Redis down; `easygas_redis_up`
is 0.

1. Restore Redis (TLS/timeouts/backoff are built in — it reconnects).
2. Expect login/OTP friction while down — this is intentional safety behavior, **do not bypass it**.
3. Once `/ready` clears, return instances to rotation.

### 3.5 Database outage (SEV-1)

`/ready` DB check fails; the app cannot serve authoritative safety decisions.

1. Restore DB connectivity (network, credentials, pool). Watch `easygas_db_pool_connections{state}`.
2. If data loss/corruption: restore from the DB backup + its paired evidence backup
   (`BACKUP-RESTORE-10F.md`; `restore-mysql.sh` is dry-run by default and refuses non-`_test` prod
   targets without `FORCE_PROD_RESTORE`).
3. After restore, run `npm run audit:verify` and a reconcile pass.

### 3.6 SMS provider outage (SEV-2)

The Eskiz provider is currently a **fail-closed stub** (a known production blocker). Behavior: the
worker won't claim messages when the provider capability isn't ready; the durable `sms_outbox`
**retains** messages (no plaintext OTP at rest).

1. Confirm via `/ready` (SMS-config check) and `easygas_sms_worker_outcomes_total` /
   `easygas_sms_outbox_messages{status}`.
2. When a real, ready provider is configured, the worker drains the outbox (backoff+jitter, max
   attempts). No OTP is lost silently; users retry once delivery is restored.

---

## 4. Who / what to check (quick index)

| Question | Where |
|---|---|
| Is the process up? | `GET /api/v1/health`, `pm2 status` |
| Are dependencies OK? | `GET /api/v1/ready` |
| What's the trend? | metrics (`OBSERVABILITY-10F.md`) |
| What happened to this request? | `x-request-id` in `pm2 logs` |
| Was history tampered? | `npm run audit:verify` + off-server checkpoints |
| Is evidence intact? | `npm run reconcile -- --deep` |
| How do I rotate a secret? | `KEY-ROTATION-10F.md` |
| How do I restore? | `BACKUP-RESTORE-10F.md`, `scripts/restore-mysql.sh` |

---

## 5. Communication

- Declare severity and open an incident channel/thread; assign an incident lead.
- Keep a timestamped action log (what was checked, what changed).
- For SEV-1 (integrity/tampering/data loss), notify the responsible owner and preserve evidence
  before remediation.
- On resolution, write a short post-incident note: root cause, impact, fix, and follow-ups (e.g.
  new alert, tightened GRANT, added check).
