# Phase 10F — Integrity, Observability & Release Readiness

Phase 10F hardens EASY GAS for operation and release: a tamper-evident audit hash chain,
dependency-free observability with a token-gated metrics endpoint, timestamp-precision
defense-in-depth, an OpenAPI 3.1 contract as the single source of truth, CI for both repos, a live
release gate, and the operational docs/artifacts (deploy, backup/restore, load test). No business
logic changed; this phase is about **integrity, visibility, and safe release**.

All items below are **implemented and tested**. Two production blockers remain (by design) and are
enforced by the live release gate.

---

## 1. What was added

### Audit integrity (tamper-evident hash chain)
Per-UTC-day hash chain over `audit_logs` (`chain_id`, `chain_seq`, `prev_hash`, `entry_hash`), a
`audit_chain_heads` lock table serializing same-day appends deadlock-free (audit is the last lock),
a deterministic canonical `entry_hash`, an append-only `BEFORE UPDATE` trigger, legacy honesty
(pre-migration rows unchained, boundary recorded in `audit_chain_checkpoints`), and a read-only
verifier (`npm run audit:verify`, `--json`, `--checkpoint`). Migration
`20260907000002_audit_log_integrity`. **Documented limitation:** a fully privileged DBA can forge a
self-consistent chain — the defense is **off-server anchoring** of checkpoints. → `AUDIT-INTEGRITY-10F.md`

### Observability
Dependency-free Prometheus metrics (`src/observability/metrics.ts`) at token-gated
`GET /api/v1/metrics` (404 unless `METRICS_ENABLED=true` + correct bearer token, timing-safe; off by
default; prod config requires a token). Low-cardinality labels only (route **templates**, method,
status_class, etc.; never job/user id/phone). `x-request-id` correlation via `pino-http`; expanded
log redaction (phone, signature, lat/long/gps/coordinates, `S3_ACCESS_KEY_ID`, `METRICS_TOKEN`).
→ `OBSERVABILITY-10F.md`

### Timestamp precision (defense-in-depth)
Migration `20260907000001_event_timestamp_precision` upgraded event-ordering columns from 1-second
`TIMESTAMP` to `DATETIME(6)` (`audit_logs.created_at`, `customer_signatures.created_at`,
`stop_approvals.submitted_at`/`decided_at`, `job_steps.completed_at`). Ordering authority remains the
monotonic numeric id (+ attempt/sort_order); timestamps are never the sole race authority.

### OpenAPI contract
OpenAPI 3.1 single source of truth (`src/openapi/spec.ts`, 88 operations / 72 paths / 18 tags) →
`docs/openapi.json` via `npm run openapi:gen`; `npm run openapi:check` validates structure, unique
operationIds, `$ref` resolution, committed-file freshness, and route drift (internal `/metrics`
excluded). Documents cookie auth, CSRF header model + rotation headers, the error envelope, both
pagination shapes, per-operation RBAC, and readiness/liveness.

### CI (both repos)
`server-ci` (build & test on MySQL+Redis services, typecheck/build/openapi:check, migration down/up,
audit smoke, full `test:all`, focused concurrency, prod `npm audit` GATE; + secret scan + actionlint)
and `client-ci` (lint/types/tests/build, bundle-size budget, prod `npm audit` GATE, Playwright spec
discovery; + actionlint). Cross-repo full-stack E2E is a separate, non-blocking workflow (default
`GITHUB_TOKEN` cannot check out a second private repo). → `CI-RELEASE-10F.md`

### Release gate
`npm run release:gate` — LIVE blockers (migrations, ACTIVE+approved risk matrix, SMS ready, audit
chain clean, readiness, prod config) + ATTESTED blockers (`release-attestation.json`). Exit 0/3/1.
**No flag bypasses a safety blocker.** → `RELEASE-CHECKLIST-10F.md`

### Operational docs & artifacts
Runbook, incident response, key rotation, backup/restore; deploy artifacts (PM2 `ecosystem.config.cjs`
with split `easygas-api` + `easygas-sms-worker`, `nginx.example.conf`, `.env.production.example`,
`crontab.example`), backup/restore scripts, and a k6 load-test smoke.
→ `OPERATIONS-RUNBOOK-10F.md`, `INCIDENT-RESPONSE-10F.md`, `KEY-ROTATION-10F.md`, `BACKUP-RESTORE-10F.md`

---

## 2. Test results (all executed this phase)

| Suite | Result |
|---|---|
| Server `npm run test:all` | **27 suites, 361 tests, 0 failed** (incl. observability 5, audit 6) |
| `npm run test:audit` | 6/6 (chaining, concurrency 15→15, append-only block, verify clean, content tamper, deletion gap) |
| `npm run test:observability` | 5/5 (redaction, 404/404/200 metrics gating, low-cardinality labels) |
| Client `npm test` | **51 tests** (7 unit + 44 component) |
| Client e2e (Playwright) | **8** (safety + visual), executed on system Edge in dev |
| Server `npm audit` | prod **0**, full **0** |
| Client `npm audit` | prod **0**, full **5** (dev-only Vitest/Vite/esbuild; fixable only by a Vitest major — deferred, never shipped) |

---

## 3. Known production blockers (UNRESOLVED — enforced by the live gate)

1. **Eskiz SMS provider is a fail-closed stub** (no verified official spec) — OTP delivery is not
   functional; production cannot be declared ready.
2. **Risk matrix v1 is DRAFT** until an EasyGas safety specialist approves it.

Both cause `npm run release:gate` to exit **3 (BLOCKED)** — as intended.

---

## 4. What remains

- Resolve the two blockers above (real Eskiz adapter against a verified spec; safety-specialist risk
  matrix approval).
- Apply the recommended branch-protection settings manually in GitHub (`CI-RELEASE-10F.md` §E).
- Configure off-server anchoring of audit checkpoints and monitoring/alerting on the metrics.
- Optional, deferred: external error tracker (e.g. Sentry) + OpenTelemetry tracing (the
  `x-request-id` is the correlation seam), and a Vitest-major upgrade to clear the dev-only client
  audit advisories.

---

## 5. Doc index

| Doc | Topic |
|---|---|
| `AUDIT-INTEGRITY-10F.md` | Audit hash chain, verification, off-server anchoring, GRANTs |
| `OBSERVABILITY-10F.md` | Logging/request-id, redaction, metrics, `/metrics` gating, cardinality |
| `CI-RELEASE-10F.md` | CI workflows, cross-repo E2E, action pinning, branch protection |
| `RELEASE-CHECKLIST-10F.md` | Release gate checks, known blockers, attestation |
| `OPERATIONS-RUNBOOK-10F.md` | PM2, rollout, migrations, scheduled jobs, metrics, shutdown, readiness |
| `INCIDENT-RESPONSE-10F.md` | Severity levels, per-scenario playbooks |
| `KEY-ROTATION-10F.md` | Rotating APP_KEY (+ side effects), DB/Redis/S3/Eskiz/metrics/CI secrets |
| `BACKUP-RESTORE-10F.md` | Backup/restore procedures (existing 10F artifact) |
| `PROJECT_STATUS.md` | Canonical, git-tracked project status |
| `openapi.json` | Generated OpenAPI 3.1 contract |
