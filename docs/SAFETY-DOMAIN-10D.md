# Phase 10D — Safety Domain Integrity

Server-authoritative risk engine, a real critical-completion gate, GPS evidence,
explicit job responsibility, immutable identity/completion snapshots, and a
signature cryptographically bound to the exact accepted work summary. Every new
safety invariant is enforced on the server and tested under concurrency.

Specification anchors: loyiha.md §12 (Job), §13 (job creation), §17 (STOP), §20
(GPS), §21 (Risk), §22 (completion gate), §23 (signature), §24 (reopen), §26
(quality), §31 (`risk_events`), §4 (permission matrix).

## Risk matrix & version (§21) — GOVERNED

Levels `LOW | MEDIUM | HIGH | CRITICAL` (from the spec). Scoring is
**server-only** under a frozen `matrix_version`; the client may propose a
hazard/severity/likelihood but never the level, score, or blocking flag. Old
`risk_events` keep the version/score/level/blocking they were scored under, so a
future matrix never rewrites past classifications.

**v1 policy** (`risk_matrix_versions`, definition JSON): `score = severity ×
likelihood` (1–4 each, 1–16). `≥12 → CRITICAL`, `≥8 → HIGH`, `≥4 → MEDIUM`, else
`LOW`. Source overrides: a rejected STOP is always `CRITICAL`; severity 4 is at
least `HIGH`. **Blocking = CRITICAL** — exactly §22's "no unresolved critical
issue".

### Governance lifecycle (approval required)

The v1 thresholds are **PROVISIONAL** — chosen during implementation, they must
be approved by EasyGas's responsible safety specialist before they govern.
`risk_matrix_versions` rows move `DRAFT → ACTIVE → RETIRED`:

- The definition is **immutable**; a change requires a NEW version.
- Activation requires the `risk.matrix.approve` permission (SIFAT/ADMIN), a
  non-empty **rationale/reference**, and passes validation (allowed
  severity/likelihood, complete score coverage, descending thresholds, unique
  version, ≥1 blocking level including CRITICAL). Exactly **one ACTIVE** at a
  time (activation retires the previous; concurrent activations serialize on a
  row lock → one ACTIVE). Create/activate/retire are audited
  (`RISK_MATRIX_CREATED/ACTIVATED/RETIRED`). **A migration never auto-approves** —
  v1 is seeded `DRAFT`.
- **Fail closed:** with no ACTIVE matrix, `assessRisk` and every safety op that
  needs it refuse with `409 RISK_POLICY_NOT_APPROVED` — **new risk assessment,
  job start, and completion/quality confirmation are all blocked**, and
  readiness reports `riskPolicy: false` (so `/ready` is 503 and the safety
  domain is never reported healthy without an approved policy).

**Activating the first matrix.** Via the API (`POST
/risk-policy/v1/activate` with a rationale, as SIFAT/ADMIN) or the bootstrap CLI
when readiness is 503:

```
npm run risk-policy -- activate --version v1 --approver <userId> --rationale "..."
```

The CLI requires an approver whose role holds `risk.matrix.approve`; there is no
default auto-approval. Dev/test activate v1 via `npm run test:setup` (a
test-only bootstrap). API surface: `GET /risk-policy` (active state, any
authenticated user — drives the warning banner), `GET /risk-policy/versions`,
`POST /risk-policy/versions` (create DRAFT), `POST /risk-policy/:v/{activate,retire}`.

## Risk state machine

`OPEN → MITIGATION_IN_PROGRESS → RESOLVED`, or `REJECTED` (used for a superseded
revision). Safety records are **never deleted**. A correction creates a NEW
superseding row (revision chain via `supersedes_id`) so a severity/likelihood
change can never be an unaudited bypass. Every mutation is audited
(`RISK_CREATED / RISK_REVISED / RISK_RESOLVED / RISK_OVERRIDE`). RBAC:
`risks.create` (USTA/MASTER), `risks.resolve` (MASTER/SIFAT/ADMIN),
`risks.override` (SIFAT/ADMIN, reason required). All lists are paginated and
branch-scoped.

## STOP ↔ risk relationship (§17)

A STOP is a safety checkpoint. When a STOP step is **REJECTED**, the same
transaction auto-creates a **blocking `CRITICAL`** risk (`source=STOP_REJECTED`),
**deduplicated** per (job, cycle, step). When the corrected STOP is **APPROVED**,
the same transaction resolves that linked risk (the approved decision is the
mitigation, referenced via `resolution_stop_approval_id`). No recursion, one
transaction boundary, independent histories preserved. A STOP approval does not
resolve any *manually*-raised risk.

## Critical completion gate (§22)

`validateJobCompletion` adds a `risks` condition: an unresolved BLOCKING risk of
the **current cycle** yields `CRITICAL_RISK_UNRESOLVED` and blocks close. Prior
cycles' risks remain visible but do not gate the current close. The gate runs
inside the close transaction (job row locked), and `confirmQuality` re-checks it.

## Lock order & concurrency

**job → cycle → checklist/steps → STOP/risk → signatures/snapshots.** Every
risk/assignment/close operation takes the **job row lock first** (`FOR UPDATE`),
so they serialize. Consequences, all tested (no sleeps — races assert the
invariant regardless of winner):

- A blocking risk cannot be created concurrently with a successful close (the
  in-tx gate sees it, or the risk is refused because the job became terminal).
- Resolve/revise racing close never yields close-with-open-blocker.
- Two simultaneous resolutions → exactly one succeeds.
- Two concurrent closes → exactly one snapshot.

DB deadlocks map through the existing 1213/1205 → `409 CONFLICT_RETRY` policy.
No object-storage / GPS / browser calls are made while holding row locks.

## Assignment & responsibility (§12/§13)

Three distinct roles: **responsible technician** (`jobs.assigned_technician_id`),
**actual step performer** (`job_steps.completed_by`, unchanged), **supervisor/
approver** (STOP/close/quality actors). Creation auto-assigns the creator
(`SELF_AT_CREATION`); `job_assignments` is an immutable history. Restricted
checklist work requires being the assigned technician (or a supervising MASTER)
— a same-branch but non-assigned USTA is refused (403).

Reassignment (`jobs.assign` → MASTER/ADMIN): target must be ACTIVE, an
operational role (USTA/MASTER), in the job's branch; refused on a terminal job;
deterministic under concurrency; audited (`JOB_REASSIGNED/UNASSIGNED`).
Reassignment never rewrites who performed past steps. `GET /jobs/mine` returns
the caller's assigned jobs (paginated, indexed).

**Legacy jobs** (pre-10D) are NOT guessed a technician — they are
`assignment_status = LEGACY_UNASSIGNED`; `created_by` is deliberately not assumed
to be the responsible technician.

## Customer/vehicle identity snapshot (§23)

Completed history must not change when live customer/vehicle rows are edited
later. The identity (customer id/name/masked-phone, vehicle id/plate/VIN/make/
model/year, branch, installation, checklist version, assigned technician) is
captured into the immutable completion snapshot at completion time. Active-job
screens may still show live data. Snapshots are server-built from authoritative
rows (no client JSON), immutable after creation; a correction requires an
explicit audited superseding row, never UPDATE-in-place. Cross-branch PII is not
exposed (phone is masked in the summary).

## Signable summary & digest (§23)

`GET /jobs/:id/signable-summary` returns a server-built human-readable summary +
its **canonical SHA-256 digest** (`summary-v1`). The digest covers MATERIAL
work: installation, checklist steps (relevant attempt + evidence sha256), STOP
state, open blocking risk ids, customer/vehicle/branch identity, assigned
technician, cycle, checklist version. It does NOT include the signature (the
customer signs THIS).

Flow: the customer sees the summary and signs; the signature binds the digest.
At close the server **recomputes** the authoritative digest — if anything
material changed, the READY signature is **stale** (`409 SIGNATURE_STALE`) and a
fresh signature is required. Re-signing supersedes the stale signature (kept in
history, `SIGNATURE_INVALIDATED` audited) and creates a new immutable record — no
overwrite. Reopen advances the cycle and invalidates prior-cycle acceptance.

## Immutable completion snapshot (§22/§23)

`completion_snapshots` — one row per successful completion **cycle** (unique
job+cycle). Server-built, **canonically serialized** (sorted keys, explicit
array order, no volatile timestamps inside the hashed content), **SHA-256**
digested (`snapshot-v1`). Content embeds the summary (+ its digest), the accepted
signature reference (id + image sha256 + summary_digest), risk assessments +
resolution state, assignment provenance, and completion actors. Finalized
**inside** the close transaction; idempotent (a retry can't re-close, and the
unique constraint + existence check prevent duplicates). The completed/history
API returns the **stored** snapshot, not a live re-join.

Canonicalization is proven (`digestOf(storedContent) === storedDigest`; key
order does not change the digest; array order does). Do not rely on
`JSON.stringify` ordering — `src/modules/completion/canonical.ts` is authoritative.

**Legacy reconstruction:** a snapshot rebuilt from current mutable tables would
NOT be contemporaneous; such a row must be marked `provenance =
LEGACY_RECONSTRUCTED` and never presented as cryptographically proven historical
data. (No legacy backfill is performed by this phase; the marker exists for a
future, explicitly-flagged reconstruction.)

## GPS evidence (§20)

`POST /jobs/:id/gps` captures **client-reported** location evidence (never proof
of physical presence). Validation (`validateGps`, pure/testable): latitude
[-90,90], longitude [-180,180], reject NaN/Infinity, reject `(0,0)` (no silent
null-island fallback), accuracy `≤ GPS_MAX_ACCURACY_METERS`, client timestamp not
older than `GPS_MAX_AGE_SECONDS` nor more than `GPS_FUTURE_SKEW_SECONDS` in the
future. Both the client and the **server receipt** timestamps are stored, bound
to job + cycle + actor + purpose, with `provenance = VALIDATED`. Capture and
rejection are audited **without** placing coordinates in the audit payload.

Policy: GPS is captured at installation (job start) and is **NOT a completion
gate** (§22's gate does not list GPS). When acceptable GPS is unavailable, an
authorized `gps.override` role records an `OVERRIDE` with a mandatory reason. No
continuous background tracking; only the required precision is exposed to
authorized roles.

Env: `GPS_MAX_ACCURACY_METERS` (100), `GPS_MAX_AGE_SECONDS` (300),
`GPS_FUTURE_SKEW_SECONDS` (120).

**Privacy/retention:** coordinates are location PII — branch-scoped, exposed only
to authorized roles, never in audit metadata or logs. Retention should be bounded
by a scheduled policy (future; not auto-collected beyond explicit capture events).

## Migrations

Reversible, additive, no destructive backfill (all verified down/up):
- `20260905000001_risk_events`
- `20260905000002_job_assignment` (adds `jobs.assigned_technician_id` /
  `assignment_status`; legacy rows → `LEGACY_UNASSIGNED`)
- `20260905000003_completion_snapshots` (+ signature `summary_digest`)
- `20260905000004_job_gps_events`
- `20260906000001_risk_matrix_versions` (governance; seeds v1 as **DRAFT**)

Safety/legal history uses `ON DELETE RESTRICT` (no cascade that silently deletes
risk/assignment/snapshot history). Microsecond `datetime(6)` where ordering
matters.

## API changes (all RBAC + branch scoped)

- `POST/GET /jobs/:id/risks`, `POST /jobs/:id/risks/:riskId/{resolve,revise,override}`
- `POST /jobs/:id/{assign,unassign}`, `GET /jobs/:id/assignment`, `GET /jobs/mine`
- `GET /jobs/:id/signable-summary`, `GET /jobs/:id/completion-snapshot`
- `POST /jobs/:id/signature` now accepts an optional `summaryDigest` field
- `POST/GET /jobs/:id/gps`, `POST /jobs/:id/gps/override`
- completion readiness adds the `risks` condition + `CRITICAL_RISK_UNRESOLVED`

New audit actions: `RISK_*`, `JOB_ASSIGNED/REASSIGNED/UNASSIGNED`,
`GPS_CAPTURED/REJECTED/OVERRIDE`, `SIGNABLE_SUMMARY_PREPARED`,
`SIGNATURE_INVALIDATED`, `COMPLETION_SNAPSHOT_FINALIZED`,
`LEGACY_SNAPSHOT_RECONSTRUCTED`.

## Deployment order

1. Back up DB. 2. Apply the four migrations (`npm run migrate`). 3. Deploy the
backend. 4. Deploy the frontend. Migrations are additive and reversible; no
backfill rewrites existing rows (legacy jobs are marked, not invented). Rollback:
frontend → backend → `migrate:rollback` (drops the new tables/columns; safety
history is lost on rollback, so export first if needed).

## Frontend (routes, roles, flows)

New routes (permission-gated in the router; the backend re-checks every request):
- `/app/my-jobs` (`checklist.execute`) — the technician's assigned-jobs queue
  (`GET /jobs/mine`), loading/empty/error/retry, `LEGACY_UNASSIGNED` flagged.
- `/app/admin/risk-policy` (`risk.matrix.approve`) — read/approve matrix
  versions; activate a DRAFT with a mandatory rationale; warns when none active.
- A global `RiskPolicyBanner` shows the "no approved policy" warning to
  `risk.matrix.approve` holders on every screen.

Reusable safety components: `CompletionReadinessPanel` (server-driven blockers;
✓/✗ with a text status, not colour alone), `GpsCaptureButton` (prompts only on
click, shows requesting/success/denied/unavailable/timeout/low-accuracy, retry,
accuracy; never fabricates a coordinate), plus the safety API client
(`api/safety.api.ts`) and the tested logic helpers (GPS/risk-form/completion/
CSRF-ordering/stale-signature). **All authority is the backend response** — the
UI never computes score/level/gate/digest.

**User flows.** GPS: explained → user clicks → browser prompt → states shown →
retry; authorized `gps.override` action with a reason is separate. Signing:
fetch the server signable summary + digest → customer confirms → sign → submit
the server digest → success only on READY; on `SIGNATURE_STALE`/`SUMMARY_STALE`
the acceptance is discarded, the summary refetched, and re-signing required.

**Client tests.** `npm run test:unit` (tsx + node:test, pure logic — GPS states,
risk-form, completion blockers, stale-signature, CSRF ordering) and `npm run
test:component` (vitest + jsdom + RTL — MyJobs states, risk-policy warning +
authorized/unauthorized controls, completion-blocker render, GPS button states).
Playwright config + specs live in `client/e2e/` (happy / blocked-completion /
GPS paths) — **not executed here** (no browser/DB harness); run locally with
`npm i -D @playwright/test && npx playwright install && npm run test:e2e` against
the isolated test DB. **Note:** vitest's dev toolchain (esbuild/vite) carries
dev-only npm-audit advisories; it never ships in the production build.

## Remaining risks / deferred

- Frontend: the safety screens are a focused increment; broader technician/
  supervisor UI polish and the Playwright happy-path are partially deferred (see
  the checkpoint) with documented manual verification.
- GPS retention automation and a scheduled deep policy are future work.
- Legacy completion-snapshot reconstruction is intentionally NOT performed (the
  provenance marker exists for a future, clearly-flagged reconstruction only).
- Out of scope (NOT implemented): real Eskiz adapter, 5 WHY, dashboards,
  notifications, offline sync, external maps/geocoding, continuous tracking.
