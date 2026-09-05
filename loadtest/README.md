# EASY GAS — safe load testing (Phase 10F artifact)

A small, **read-only**, **safety-gated** k6 smoke/load test for the EASY GAS
API. It exists to catch gross regressions in latency/error behaviour on a
**non-production** environment — not to certify capacity.

> **k6 is not installed and is not a project dependency.** Install it yourself
> (https://k6.io/docs/get-started/installation/) and run the script with
> `k6 run`. This directory adds no npm dependencies.

---

## What it does

`smoke.js`:

- **Refuses to run** unless `ALLOW_LOAD_TEST=1` is set.
- **Refuses any production target**: if the `TARGET` host matches the
  `PROD_HOSTS` denylist it aborts, with **no override**.
- Logs in with a **TEST account** (`E2E_PHONE` / `E2E_PASSWORD`) — never real
  credentials, never a real user.
- Exercises a gradual, **small** ramp (0 → 10 → 25 VUs over a few minutes).
- Hits **READ-ONLY** endpoints only:
  - `GET /api/v1/health` (liveness)
  - `GET /api/v1/ready` (readiness; 200 or 503 both accepted)
  - `GET /api/v1/jobs` (list; the main filtered query)
  - `GET /api/v1/jobs/:id` (detail)
  - `GET /api/v1/jobs/:id/checklist` (checklist read)
  - `GET /api/v1/jobs/:id/risks` (per-job risk list, paginated)
  - `GET /api/v1/jobs/:id/completion` (evidence/completion **metadata**, not the
    signature file bytes)
- Exercises **login / rate-limit** with the test account: a `429` under load is
  treated as an expected, valid outcome (the fail-closed limiter working), not
  an error.
- Reports **k6 thresholds**: `http_req_duration p95 < 800ms`, functional
  `errors rate < 1%`, `checks rate > 99%` (tune to your environment).

### What it deliberately does NOT do
- **No writes / mutations** of any kind (no create/complete/assign/cancel).
- **No file uploads** — `ENABLE_UPLOAD` is intentionally unsupported; the script
  aborts if you set it, so nobody accidentally mass-uploads evidence.
- **No real SMS** — it never calls OTP request / forgot-password send flows.
- **No data cleanup** — it creates nothing to clean.

---

## Usage

```bash
# From the server/ directory, against a LOCAL or STAGING instance only:
ALLOW_LOAD_TEST=1 \
TARGET=http://127.0.0.1:4000 \
E2E_PHONE='<test account phone>' \
E2E_PASSWORD='<test account password>' \
k6 run loadtest/smoke.js
```

### Environment variables
| Var | Required | Default | Purpose |
|---|---|---|---|
| `ALLOW_LOAD_TEST` | **yes** | — | Must be `1` or the test refuses to run. |
| `TARGET` | no | `http://127.0.0.1:4000` | Base URL (without `/api/v1`). |
| `E2E_PHONE` | **yes** | — | TEST account phone. |
| `E2E_PASSWORD` | **yes** | — | TEST account password. |
| `PROD_HOSTS` | no | `easygas.uz,api.easygas,prod,production` | Comma-separated denylist tokens; a matching `TARGET` host is refused. |
| `ENABLE_UPLOAD` | no | (off) | Intentionally unsupported — setting `1` aborts the run. |

A dedicated test account must exist in the target's database (e.g. via the
seed / a staging fixture). Never point `E2E_*` at a real user.

---

## Reading the results

k6 prints per-endpoint metrics (each request is tagged, e.g. `jobs:list`,
`jobs:risks`) plus the threshold pass/fail summary. A non-zero exit means a
threshold failed. Watch `http_req_duration{name:...}` per endpoint to see which
read is slow.

---

## IMPORTANT: what a passing local run does and does NOT prove

**A passing local/staging smoke test does NOT prove 5,000-user capacity.** It
runs a handful of VUs against (usually) a small dataset and a single node. Real
capacity depends on production data volumes, DB indexes, Redis latency, network,
Nginx, instance count and hardware. Use this to catch **regressions**, then do
proper capacity planning separately (larger datasets, production-like infra,
longer soak tests, realistic mixes).

### DB queries / indexes to watch as data grows
- **Jobs list filters** (`GET /api/v1/jobs`): the branch-scoped, status/date/
  assignment-filtered, paginated query is the hottest read — ensure indexes back
  the actual filter + sort columns; watch for full scans as job count grows.
- **Per-job risk list** (`GET /api/v1/jobs/:id/risks`): paginated per job and
  per cycle — ensure the `(job, cycle)` access path is indexed.
- **Audit inserts** (write path, exercised indirectly): every mutation appends
  to the tamper-evident audit chain; under write load this is an
  insert-throughput and lock-contention point. This read-only smoke test does
  **not** stress it — capacity-test writes separately, carefully, and never
  against production.
- **Session rotation** (`SELECT ... FOR UPDATE`): row-lock contention under
  concurrency; watch lock waits.
- Redis round-trips for rate limiting on the auth endpoints (login/OTP): watch
  Redis latency and the `429` rate.
