# Observability — Phase 10F

Structured logging with correlation IDs, secret/PII redaction, and a dependency-free Prometheus
metrics endpoint that is **token-gated and off by default**. This document covers logging, the
request-id seam, redaction, the full metrics list, `/metrics` access control, the cardinality
rules, and the optional external integrations we deliberately did **not** wire up.

---

## 1. Logging & request correlation

- **Request id:** every request gets/echoes an `x-request-id` header. An inbound value is accepted
  **only if it matches a safe pattern**; otherwise a fresh UUID is generated. Wired via
  `pino-http` `genReqId`.
- **Request logs** carry the **route template** (e.g. `/api/v1/jobs/:id`) and `actorId` — never a
  phone number or other PII, never a raw path parameter.
- The request id is the **correlation seam**: it appears in logs and is the natural key to tie a
  request to any future external tracing/error-tracking integration (see §7).

---

## 2. Log redaction (`src/utils/logger.ts`)

The logger redacts sensitive keys wherever they appear in log objects. Phase 10F **adds**
safety-sensitive and new-secret fields to the pre-existing list:

| Category | Redacted keys |
|---|---|
| Added in 10F | `phone`, `signature`, `latitude`, `longitude`, `gps`, `coordinates`, `S3_ACCESS_KEY_ID`, `METRICS_TOKEN` |
| Pre-existing | `password`, `otp`, `token`, `cookie`, `csrf`, `REDIS_URL`, `S3_SECRET`, `ESKIZ_PASSWORD` |

Verified by `test:observability` (redaction of both secrets and safety-sensitive fields).

---

## 3. Metrics implementation

- **Dependency-free** Prometheus text exposition in `src/observability/metrics.ts` — a small
  `Counter` / `Gauge` / `Histogram` set plus a registry. No `prom-client` dependency.
- Exposed at **`GET /api/v1/metrics`** in the standard Prometheus text format.

### Metrics list

**All labels are low-cardinality** (see §5). Series:

| Metric | Type | Labels |
|---|---|---|
| `easygas_http_requests_total` | counter | route template, method, status_class (`2xx`/`4xx`/…) |
| `easygas_http_request_duration_seconds` | histogram | route template, method |
| `easygas_rate_limit_rejections_total` | counter | `limiter`, `mode` |
| `easygas_sms_worker_outcomes_total` | counter | `outcome` |
| `easygas_storage_failures_total` | counter | — |
| `easygas_audit_verification_failures_total` | counter | — |
| `easygas_db_pool_connections` | gauge | `state` (pool state) |
| `easygas_redis_up` | gauge | — |
| `easygas_redis_backend` | gauge | `kind` |
| `easygas_readiness_check` | gauge | `check` (check name) |
| `easygas_readiness_up` | gauge | — |
| `easygas_unresolved_blocking_risks` | gauge | — |
| `easygas_sms_outbox_messages` | gauge | `status` |
| process metrics | gauge | RSS, heap, uptime |
| Node.js event-loop lag | gauge | — |

---

## 4. `/metrics` access control

The endpoint is **opt-in and token-gated** — it is never public by accident:

| Condition | Result |
|---|---|
| `METRICS_ENABLED` unset/false (the default) | **404** (existence not advertised) |
| Enabled but wrong/absent `Authorization: Bearer <token>` | **404** |
| `METRICS_ENABLED=true` **and** correct bearer token (timing-safe compare) | **200** + metrics |

- `METRICS_ENABLED` **defaults to FALSE**.
- The token is compared **timing-safe**.
- **Production config validation requires `METRICS_TOKEN`** whenever `METRICS_ENABLED=true`; in
  production the endpoint is refused unless a token is set and matched.
- **Defense in depth:** the deploy layer (Nginx) must also keep `/metrics` off the public vhost —
  scrape it only from the trusted internal network. (The OpenAPI route-drift check intentionally
  **excludes** `/metrics`, so it is not advertised in the public contract either.)

---

## 5. Cardinality rules

Metrics use **only low-cardinality labels**. Never label a series with a job id, user id, phone,
or any raw request parameter.

- **Route templates only.** Paths are normalized — numeric ids become `:id` — with a **hard
  cardinality cap**: anything unrecognized collapses to `/other` so an attacker cannot explode the
  series count with random paths.
- Allowed label kinds: route template, method, status_class, limiter name, outcome, check name,
  pool state, backend kind, message status.

Verified by `test:observability`: labels stay low-cardinality (route templates present; no raw job
id or phone appears in any series).

---

## 6. Tests — `npm run test:observability`

`tests/observability.e2e.ts`, 5 tests, all passing:

1. Redaction of secrets **and** safety-sensitive fields (phone/signature/GPS).
2. `/metrics` returns **404** without a token.
3. `/metrics` returns **404** with a **wrong** token.
4. `/metrics` returns **200** with the **correct** token.
5. Low-cardinality labels: route templates present, no raw job id/phone in labels.

---

## 7. Optional external integration points (NOT enabled)

These require **no credentials to build** and are documented as future options only — **do not add
them now**:

- **Error tracking** — e.g. Sentry via a DSN env var. The `x-request-id` is the correlation key
  you would attach to each captured event.
- **OpenTelemetry tracing** — spans keyed off the same request id.

The request-id seam already exists, so either can be layered in later without changing the
application's public surface.
