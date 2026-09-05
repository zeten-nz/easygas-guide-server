# EASY GAS — PROJECT STATUS (canonical)

> This is the **canonical, git-tracked** project status. The copy at the repo-root
> (`../../PROJECT_STATUS.md`, outside both git repos) is now **non-authoritative**.

**Current phase:** Phase 10F — Integrity, Observability & Release Readiness — **implemented +
tested**. Two production blockers remain (by design), enforced by the live release gate.

**Repos:** two separate git repositories — `server/` and `client/`. Project-root files (like the old
`PROJECT_STATUS.md`) live **outside** both repos.

---

## Status legend

- **IMPLEMENTED** — built and in the codebase.
- **TESTED** — covered by an automated suite that was executed and passed.
- **MANUALLY-VERIFIED** — confirmed by hand (e.g. browser E2E on a system browser).
- **PRODUCTION-BLOCKED** — cannot go to production until resolved; enforced by the release gate.
- **DEFERRED** — deliberately not done now; documented.

---

## Phase 10F — Integrity, Observability & Release Readiness

Full detail: `PHASE-10F.md` and the topic docs listed at the bottom.

### Audit integrity — IMPLEMENTED + TESTED
- Tamper-evident **per-UTC-day hash chain** over `audit_logs` (`chain_id`, `chain_seq`, `prev_hash`,
  `entry_hash`); `audit_chain_heads` lock table serializes same-day appends (deadlock-free, audit is
  the last lock); deterministic canonical `entry_hash` (`created_at` intentionally not hashed).
  Migration `20260907000002_audit_log_integrity` (reversible).
- Append-only `BEFORE UPDATE` trigger (`audit_logs_no_update`); deletion is **detected** via a
  `chain_seq` gap (blocked in prod via restricted GRANTs, not at DB level in tests).
- **Legacy honesty:** pre-migration rows are NOT retro-chained (`chain_id` NULL); boundary recorded
  in `audit_chain_checkpoints`. No historical-integrity claim for them.
- Verifier `npm run audit:verify` (read-only, `--json`, `--checkpoint`); exit 0/2/1.
- **DOCUMENTED LIMITATION:** a fully privileged DBA can forge a self-consistent chain — the only
  defense is **off-server anchoring** of checkpoints.
- **TESTED:** `npm run test:audit` — 6/6 (chaining, concurrency 15→15 no dup seq, append-only block,
  verify clean, content tamper, deletion gap).

### Observability — IMPLEMENTED + TESTED
- Dependency-free Prometheus metrics; token-gated `GET /api/v1/metrics` (404 unless
  `METRICS_ENABLED=true` + correct bearer, timing-safe; **off by default**; prod config requires a
  token). Low-cardinality labels only (route templates, method, status_class, …; never id/phone).
- `x-request-id` correlation (safe-pattern inbound or fresh UUID); expanded log redaction (phone,
  signature, lat/long/gps/coordinates, `S3_ACCESS_KEY_ID`, `METRICS_TOKEN`).
- **TESTED:** `npm run test:observability` — 5/5 (redaction, 404/404/200 gating, low-cardinality).
- **DEFERRED:** external error tracker (Sentry) + OpenTelemetry tracing (request-id is the seam).

### Timestamp precision — IMPLEMENTED
- Migration `20260907000001_event_timestamp_precision` (reversible, down/up verified): ordering
  columns upgraded 1-second `TIMESTAMP` → `DATETIME(6)`. Defense-in-depth only; the monotonic numeric
  id (+ attempt/sort_order) remains the authoritative tie-breaker.

### OpenAPI contract — IMPLEMENTED + TESTED (CI gate)
- OpenAPI 3.1 single source of truth (`src/openapi/spec.ts`, 88 operations / 72 paths / 18 tags) →
  `docs/openapi.json` (`npm run openapi:gen`). `npm run openapi:check` validates structure, unique
  operationIds, `$ref` resolution, committed-file freshness, and **route drift** (`/metrics`
  excluded). Documents cookie auth, CSRF model + rotation headers, error envelope, pagination, RBAC,
  readiness/liveness.

### CI — IMPLEMENTED
- `server-ci`: build & test (MySQL 8 + Redis 7 services, throwaway APP_KEY, typecheck/build,
  `openapi:check`, migration down/up, audit smoke, full `test:all`, focused concurrency, prod
  `npm audit` GATE) + secret scan (gitleaks) + actionlint; least-privilege, concurrency cancel,
  timeouts, actions pinned to release tags (note: pin to SHAs in-org).
- `client-ci`: lint · types · tests · build, bundle-size budget (main gz ≤175 KB / total gz ≤320 KB;
  current ~121/~210), prod `npm audit` GATE, Playwright spec discovery + actionlint.
- `e2e-fullstack` (client): **separate, non-blocking** cross-repo browser E2E — the default
  `GITHUB_TOKEN` cannot check out a second private repo, so it needs `SERVER_REPO` + read-only
  `SERVER_REPO_TOKEN`; fails loudly if unconfigured.
- **Branch protection = RECOMMENDATION only** (configure in GitHub manually): see `CI-RELEASE-10F.md`
  §E for required checks and PR/force-push/environment rules.

### Release gate — IMPLEMENTED
- `npm run release:gate` (`--json` + human): LIVE blockers (migrations, ACTIVE+approved risk matrix,
  SMS ready, audit chain clean, readiness, prod config) + ATTESTED blockers
  (`release-attestation.json`; template `release-attestation.example.json`). Exit 0=READY, 3=BLOCKED,
  1=error. **No flag bypasses a safety blocker.**

### Operations — IMPLEMENTED (artifacts) + MANUALLY-VERIFIED (procedures documented)
- Docs: `OPERATIONS-RUNBOOK-10F.md`, `INCIDENT-RESPONSE-10F.md`, `KEY-ROTATION-10F.md`,
  `BACKUP-RESTORE-10F.md`.
- Artifacts (reference, not recreated): `deploy/{ecosystem.config.cjs (split easygas-api +
  easygas-sms-worker, kill_timeout 30s > 25s shutdown), nginx.example.conf, .env.production.example,
  crontab.example}`; `scripts/{backup-mysql.sh, backup-evidence.sh, restore-mysql.sh}`;
  `loadtest/{smoke.js, README.md}`.

### KNOWN PRODUCTION BLOCKERS — PRODUCTION-BLOCKED (enforced by the live gate)
1. **Eskiz SMS provider is a fail-closed STUB** (no verified official spec) — OTP delivery not
   functional; production cannot be declared ready.
2. **Risk matrix v1 is DRAFT** until an EasyGas safety specialist approves it.

### Test summary (executed this phase)
- Server `test:all`: **27 suites, 361 tests, 0 failed** (incl. observability 5, audit 6).
- Client: **51 tests** (7 unit + 44 component) — **TESTED**; **8** Playwright (safety + visual) —
  **MANUALLY-VERIFIED** on system Edge in dev.
- Audits: server prod 0 / full 0; client prod 0 / full 5 (dev-only Vitest/Vite/esbuild — **DEFERRED**,
  fixable only by a Vitest major, never shipped).

---

## Prior phases (carried-forward summary)

All phases below are **IMPLEMENTED + TESTED** unless noted. Full history remains in the repo-root
`PROJECT_STATUS.md` (non-authoritative) and each phase's topic doc.

| Phase | Summary | Notes |
|---|---|---|
| **1** | Authentication: login, remember-me, logout, registration→admin approve/reject, password reset (SMS OTP), DB sessions with revocation, rate limiting, audit logging, Uzbek auth UI | 19 E2E |
| **2** | Centralized RBAC (`permissions.ts` + `requirePermission`), user & branch management (soft status only, FK RESTRICT), admin safety rules | 19 E2E |
| **3** | Customers + vehicles global registry (name+phone; normalized plate/VIN; audited transfer, no duplication) | 18 E2E |
| **4** | Jobs core entity, §12 status set, branch scoping (§11), explicit audited start/cancel, no DELETE/soft-delete | 23 E2E |
| **5** | Checklist templates/versions (DRAFT→PUBLISHED→ARCHIVED, immutable), sequential execution, decimal-safe measurement validation, installation details | 26 E2E |
| **6** | STOP approvals (§17–18): MASTER-only decide, immutable history, row-locked | 17 E2E |
| **7** | §3 correction loop (rework, attempt-scoped), §19 photo evidence + storage abstraction, magic-byte upload security | 20 E2E |
| **8** | §22 completion gate (server re-recalculates all conditions), customer signature artifact, MASTER close | 15 E2E |
| **9** | §24 reopen cycle (SIFAT/ADMIN), selected-step redo, QUALITY_REVIEW → quality confirm, read-only §26 inspection | 15 E2E |
| **10A** | Security hardening: CSRF, trust-proxy, OTP/reset/last-admin/assign/branch races, isolated test DB, error mapping | `SECURITY-PHASE-10A.md` |
| **10B** | Evidence storage lifecycle (PENDING→READY→FAILED, UNVERIFIED legacy), two-transaction upload, S3/MinIO provider, reconciliation, signature cycle binding | `EVIDENCE-STORAGE-10B.md` |
| **10C** | Session lifecycle, Redis abstraction, atomic rate limiting (fail-closed auth), durable encrypted SMS outbox + worker, readiness/liveness, graceful shutdown, prod config validation, cleanup CLI. **Eskiz adapter deferred** (fail-closed stub) | `PRODUCTION-RUNTIME-10C.md` |
| **10D** | Safety domain: server-authoritative risk engine + versioned matrix governance (DRAFT→ACTIVE→RETIRED, one-ACTIVE singleton), §22 critical-completion gate, assignment/responsibility, immutable snapshots (SHA-256), GPS evidence. **Risk matrix v1 DRAFT/provisional** | `SAFETY-DOMAIN-10D.md` |
| **10E** | Frontend integration & branding: real EASY GAS branding, light-first token system, safety widgets wired into routed job-detail, route code-splitting, error boundaries; risk-policy concurrency made race-proof; Playwright reproducible (8/8 on Edge) | `client/docs/FRONTEND-UX-10E.md` |

---

## Doc index (Phase 10F, canonical)

| Doc | Topic |
|---|---|
| `PHASE-10F.md` | Phase summary |
| `AUDIT-INTEGRITY-10F.md` | Audit hash chain, verification, off-server anchoring, GRANTs |
| `OBSERVABILITY-10F.md` | Logging/request-id, redaction, metrics, `/metrics` gating, cardinality |
| `CI-RELEASE-10F.md` | CI workflows, cross-repo E2E, action pinning, branch protection |
| `RELEASE-CHECKLIST-10F.md` | Release gate checks, known blockers, attestation |
| `OPERATIONS-RUNBOOK-10F.md` | PM2, rollout, migrations, scheduled jobs, metrics, shutdown, readiness |
| `INCIDENT-RESPONSE-10F.md` | Severity levels, per-scenario playbooks |
| `KEY-ROTATION-10F.md` | Rotating APP_KEY (+ side effects), DB/Redis/S3/Eskiz/metrics/CI secrets |
| `BACKUP-RESTORE-10F.md` | Backup/restore procedures |
| `openapi.json` | Generated OpenAPI 3.1 contract |
