# Phase 10C — Session, Redis, SMS and Production Runtime

Hardens the runtime for a real deployment: a documented server-side session
lifecycle with rotation, shared Redis-backed rate limiting, a durable SMS outbox
with an async worker, liveness/readiness endpoints, graceful shutdown, retention
maintenance, and production configuration validation.

> **Eskiz status (deferred, fail-closed):** the production SMS provider is
> Eskiz.uz, but its official API documentation (the owner's Postman documenter
> link) is a client-rendered SPA that could not be machine-verified during 10C.
> Implementing its auth/endpoints/delivery-status from memory or third-party
> wrappers is forbidden, so the Eskiz **adapter** (`src/sms/eskiz.provider.ts`)
> is a stub that declares itself **not implemented**. Everything else — the
> durable outbox, worker, OTP lifecycle — is provider-agnostic and complete.
>
> **Production OTP delivery remains BLOCKED until the real Eskiz adapter is
> implemented from verified official documentation.** Phase 10C is NOT
> production-ready while this blocker stands. The system fails **closed** on it
> (see [SMS provider fail-closed](#sms-provider-fail-closed-capability-gating)):
> a production instance refuses to start, and `/ready` never returns 200, on a
> non-functional provider — so it can never accept auth/OTP traffic it cannot
> serve. See [Implementing Eskiz](#implementing-eskiz-when-the-spec-is-verified).

## SMS provider fail-closed (capability gating)

Each provider declares an `implemented` flag; `smsCapability()` derives
`{ implemented, configured, ready }` **without sending** (a stub or a
console-in-production provider is never `ready`). This is enforced at three
points so a knowingly-unusable provider never serves traffic:

1. **Startup:** in production, `smsStartupProblem()` makes the process **refuse
   to boot** on a non-ready provider (Eskiz stub, console, or missing creds) with
   a sanitized error (no credentials/internals).
2. **Readiness:** `/api/v1/ready` returns **503** (`checks.sms=false`) whenever
   the selected provider is not ready — never 200 for a stub.
3. **Worker:** the outbox worker does **not claim** messages when the provider is
   not ready — queued OTPs wait as `PENDING` (no attempts burned) instead of
   failing on the stub. It also refuses to start its poller.

Dev/test may use `console` or an injected fake explicitly (`implemented=true`);
`console` stays forbidden in production.

## Session lifecycle (A/B)

Opaque 256-bit tokens; only their SHA-256 is stored; HttpOnly cookie, `Secure`
in production, `SameSite=Lax` (compatible with the Phase 10A CSRF layers).

| Property | Env | Default |
|---|---|---|
| Absolute lifetime cap (remember-me) | `SESSION_ABSOLUTE_DAYS` | 30 |
| Idle timeout (all sessions) | `SESSION_IDLE_MINUTES` | 720 (12h) |
| Rotation interval | `SESSION_ROTATE_MINUTES` | 60 |
| Rotation concurrency grace | `SESSION_ROTATION_GRACE_SECONDS` | 30 |

- **Rotation** happens at most once per interval. It is atomic across parallel
  requests and PM2 instances: the winner holds a `SELECT … FOR UPDATE` row lock
  while it mints the successor, so two concurrent requests can never create two
  divergent successors (no process mutex is used). A request that loses the race
  serves on the old token during the grace window and adopts the new cookie on
  its next request.
- **Grace / replay:** a rotated-out (superseded) token is accepted within the
  grace window; used *after* grace it is treated as a **replay** and the whole
  session **family** is revoked.
- **CSRF coordination:** the CSRF token is `HMAC(APP_KEY, "csrf:"+cookie)`, so a
  rotated cookie yields a new CSRF token. Every authenticated response carries
  `x-csrf-token` and a monotonic `x-session-rotation` sequence (exposed via CORS
  `exposedHeaders`). The SPA adopts a token only when its sequence is newer, so
  an out-of-order older response can't clobber a newer token. The session cookie
  value is never exposed to JS.
- **Revocation:** logout, password reset, user block, and branch deactivation
  hard-revoke sessions. A sensitive **role change** takes effect immediately via
  per-request re-evaluation (the middleware reloads role + permissions every
  request — continuous re-authorization, stronger than revocation for a
  demotion); it is not additionally hard-revoked to avoid a needless re-login.

## Redis (C)

`RedisLike` abstraction (`src/redis/redis.ts`): ioredis-backed in production, an
in-memory implementation in dev/test (no Redis server needed in CI).

| Env | Default | Notes |
|---|---|---|
| `REDIS_URL` | — | `redis://…` or `rediss://…` (TLS). **Required in production.** |
| `REDIS_CONNECT_TIMEOUT_MS` | 10000 | connect timeout |
| `REDIS_COMMAND_TIMEOUT_MS` | 5000 | per-command timeout |
| `REDIS_KEY_PREFIX` | `eg:` | key namespace |

Bounded reconnect backoff; `enableOfflineQueue:false` (fail fast, the rate
limiter decides policy); credentials are never logged; `connectRedis()` races a
ping against a timeout so startup never hangs. Production refuses to start
without `REDIS_URL`.

**Local dev with Redis (optional):** `docker run -p 6379:6379 redis:7` then set
`REDIS_URL=redis://127.0.0.1:6379`. Without it, dev uses the in-memory limiter.

## Shared rate limiting (D)

Redis-backed atomic fixed-window, shared across PM2 instances and restarts. The
increment-and-expiry is a **single atomic Lua `EVAL`** (INCR, PTTL, conditional
PEXPIRE server-side) — never two separate round-trips — so a counter can never be
left without a TTL. The script also **repairs** any key found without a TTL
(sets the window on the next increment), so a stray key can never block a user
forever; a later hit within the window keeps the **original** expiry. It returns
`{count, ttlMs}`, and `Retry-After` is derived from that returned TTL (not a
local wall-clock assumption). `MemoryRedis` reproduces the same observable
semantics for dev/test. Keys are namespaced (`rl:<name>:<dim>`) and never contain
PII — phone limits key on an **HMAC** of the normalized number. IP limits use the
trusted `req.ip` (Phase 10A `TRUST_PROXY_HOPS`), so a spoofed `X-Forwarded-For`
cannot reset a counter. Blocked requests get `429` + `Retry-After`; account
existence is never revealed.

**Failure policy:** login / OTP request / OTP verify / reset / registration fail
**closed** (blocked) when Redis is unavailable — abuse controls are never
silently disabled; general API traffic and authenticated uploads fail **open**
(allowed, logged).

## Durable SMS outbox + worker (E/G)

A message is persisted first (`sms_outbox`, PENDING) inside the producing
transaction, then delivered by a worker — no fragile write-then-call flow. The
rendered body is **encrypted at rest**; the plaintext OTP is never stored,
logged, or audited.

### Body encryption (AES-256-GCM)

- **Envelope:** `v1:ivHex:tagHex:ciphertextHex` — versioned so the format can
  evolve; a fresh random **96-bit IV** per message; the **auth tag is verified
  before any plaintext is returned**; malformed IV/tag/ciphertext or an unknown
  version is strictly rejected.
- **AAD:** the ciphertext is bound to stable metadata — `version | type |
  sha256(recipient)` (never the raw number; the auto-increment id is not bound as
  it is unknown pre-insert) — so a body cannot be swapped onto a row of a
  different type/recipient.
- **Key:** a dedicated `SMS_OUTBOX_ENCRYPTION_KEY` (32 bytes, hex or base64) when
  set, else an **HKDF-SHA256** subkey derived from `APP_KEY` with a unique
  context (`easygas:sms-outbox:v1`) — domain-separated from the OTP/reset HMAC.
  The key is **always deterministic** (never an ephemeral random key, which would
  make queued messages undecryptable after a restart). A malformed dedicated key
  (wrong decoded length) is rejected at config validation / first use (fail
  closed). Production validates the decoded length is exactly 32 bytes.
- **Decryption failure** (wrong key/AAD, tamper, corruption): the message is
  moved to a **terminal `FAILED(PAYLOAD_DECRYPT)`** state for manual review — it
  is **never** retried indefinitely and its (undecryptable) content **never
  reaches `SmsProvider.send()`**; a redacted operator log is emitted (no body).

### Key rotation

The envelope carries a version (`v1`) and the derivation a context id. To rotate:
(1) **drain** the outbox (stop enqueuing, let the worker deliver/expire pending
messages — they are short-lived, ≤`SMS_MAX_AGE_SECONDS`); (2) set the new
`SMS_OUTBOX_ENCRYPTION_KEY` (or rotate `APP_KEY`) and restart. New messages use
the new key; because pending messages were drained first, none become
undecryptable. If the configured key is **missing/invalid**, the app fails
closed (config validation error / decrypt quarantine) rather than silently
generating an ephemeral key. A future multi-key scheme would bump the envelope
version and try key-by-id on decrypt.

States: `PENDING → PROCESSING (leased) → SENT (accepted) / DELIVERED (only if
the provider confirms handset delivery) / RETRY / FAILED / CANCELLED`.

- **Accepted vs delivered:** most gateways confirm only *acceptance*; `SENT`
  means accepted, `DELIVERED` is set only on a confirmed handset delivery. We do
  not claim delivery from acceptance.
- **Worker:** DB-leased claims (per-row conditional `UPDATE`, no double
  processing across PM2 instances), bounded batch + concurrency, exponential
  backoff + jitter, max attempts, stale-lease recovery, graceful stop.
- **Ambiguous timeout:** recorded as `FAILED(AMBIGUOUS:…)` and **not** blindly
  retried (it may already have been accepted) — flagged for operator
  reconciliation.
- **OTP lifecycle:** the OTP hash and its validity window are created together
  with the queued (encrypted) SMS in one transaction; resend supersedes the
  prior OTP **and** cancels its still-queued message; a message older than
  `SMS_MAX_AGE_SECONDS` when the worker picks it up is **CANCELLED**, never
  delivered (an OTP must not arrive after it expires). **OTP expiry starts at
  creation** (`OTP_TTL_MINUTES`), independent of when Eskiz accepts the message;
  `SMS_MAX_AGE_SECONDS` bounds the acceptable queue delay so a code cannot be
  delivered after it has expired.

| Env | Default |
|---|---|
| `SMS_PROVIDER` | — (`console` dev-only, or `eskiz`) |
| `SMS_MAX_ATTEMPTS` | 5 |
| `SMS_REQUEST_TIMEOUT_MS` | 15000 |
| `SMS_MAX_AGE_SECONDS` | 300 |
| `SMS_WORKER_ENABLED` | on (`false` disables the in-process worker) |
| `SMS_WORKER_INTERVAL_MS` | 5000 |
| `SMS_WORKER_BATCH` | 20 |
| `SMS_LEASE_SECONDS` | 60 |

### Implementing Eskiz when the spec is verified

Localized to `src/sms/eskiz.provider.ts`. Env (validated only when
`SMS_PROVIDER=eskiz`): `ESKIZ_EMAIL`, `ESKIZ_PASSWORD`, `ESKIZ_FROM` (an
**approved sender name** — requires Eskiz account approval), `ESKIZ_BASE_URL`
(default `https://notify.eskiz.uz/api`). Implementation notes: authenticate at
the login endpoint; cache the bearer token (in memory or Redis) and refresh on
documented expiry / a `401`; POST to the send endpoint with `ESKIZ_FROM`;
capture the provider message id; map errors to `SmsSendError` kinds; treat a
request timeout as `AMBIGUOUS`; validate response schemas and reject unexpected
HTML; strict connection/request timeouts; **never log** the login, password,
bearer token or OTP.

## Liveness & readiness (H)

- `GET /api/v1/health` — **liveness**, no external deps, `{status:"ok"}`.
- `GET /api/v1/ready` — **readiness**: checks DB, Redis, storage (non-destructive
  stat), and SMS config (no send) with strict per-check + overall timeouts;
  returns `503` when any fails or during graceful shutdown. Exposes only
  booleans — no hostnames, credentials or stack traces.

## Graceful shutdown (I)

On `SIGTERM`/`SIGINT`: mark readiness false → stop accepting new connections
(`server.close`) → stop claiming SMS work and drain the in-flight batch → close
Redis → destroy the Knex pool → exit; a hard timeout (25s, must be below the PM2
kill timeout) forces exit. Idempotent; a second signal forces immediately.
`uncaughtException`/`unhandledRejection` log and exit non-zero (PM2 restarts).

## Maintenance / retention (J)

```
npm run cleanup              # dry-run: counts only
npm run cleanup -- --apply   # delete/recover eligible records (bounded batches)
```

Deletes expired/revoked sessions, expired OTP rows, and terminal SMS outbox rows
past their retention; recovers stale SMS `PROCESSING` leases; **reports** stale
PENDING evidence (the audited fix is `npm run reconcile -- --apply`). Rate-limit
keys expire on their own in Redis. Dry-run by default, idempotent, bounded, and
guarded by a MySQL advisory lock (`GET_LOCK`) so concurrent runs no-op. Retention
via `SESSION_RETENTION_DAYS` (30), `OTP_RETENTION_DAYS` (7),
`SMS_OUTBOX_RETENTION_DAYS` (30). Prefer an **external** cron over an in-process
timer (which would run once per PM2 worker), e.g.:

```
# /etc/cron.d/easygas — 03:30 daily
30 3 * * * easygas cd /srv/easygas/server && npm run cleanup -- --apply >> /var/log/easygas/cleanup.log 2>&1
```

## Production configuration validation (K)

At startup in production the server refuses to boot (`assertProductionConfig`)
unless: `APP_KEY` is strong; `TRUST_PROXY_HOPS>=1`; `REDIS_URL` set; storage is
`s3` (or the documented local override); a real `SMS_PROVIDER` with credentials;
`CLIENT_ORIGIN` is the real public origin; session timings are sane
(`rotate < idle <= absolute`); and the DB is not a `*_test` schema. Logs redact
cookies, CSRF tokens, OTP codes, phone numbers, Redis URLs, and S3/Eskiz
credentials/Authorization headers.

## PM2 / Nginx / firewall

- **PM2:** run the API (`node dist/server.js`); set `kill_timeout` **> 25000**
  so graceful shutdown completes. The SMS worker runs in-process and is
  PM2-safe (DB-leased), but a **single dedicated worker process** (e.g. a
  separate PM2 app with `SMS_WORKER_ENABLED=true` and the API instances set to
  `false`) avoids N concurrent pollers.
- **Nginx:** health-check `/api/v1/ready` (route traffic only on `200`); it flips
  to `503` during shutdown so the proxy drains the instance. Terminate TLS at
  Nginx; proxy to the Node port.
- **`TRUST_PROXY_HOPS=1`** is safe **only** when all public traffic passes
  through exactly one trusted Nginx proxy **and the Node port is not publicly
  reachable** (firewall it to localhost / the private network). More hops than
  real proxies let clients spoof their IP via `X-Forwarded-For`.

## Deployment order

1. Provision/verify **Redis** (TLS + auth in production).
2. Apply DB **migrations** (`npm run migrate`): `20260904000020_session_lifecycle`,
   `20260904000021_sms_outbox`.
3. Deploy **backend** (validates prod config at boot; refuses to start if Redis /
   S3 / SMS / proxy config is wrong).
4. Start the **SMS worker** (in-process or a dedicated PM2 app).
5. Point Nginx health checks at `/api/v1/ready`.
6. Deploy **frontend** (adopts rotated CSRF tokens; handles session expiry).
7. Smoke-test: login, a rotation (after the interval), a mutation, an OTP reset.

Backend and frontend are compatible across the rotation change (the client
tolerates responses with or without the rotation headers), but deploy the
backend first.

## Rollback

Frontend rollback first (safe — it degrades to no rotation handling), then
backend, then — only if necessary — `npm run migrate:rollback` (down/up verified;
rolling back drops the session-lifecycle columns and the `sms_outbox` table, so
any queued-but-unsent SMS is lost — drain the outbox first).

## Observability & remaining risks

- Structured (redacted) logs for auth, rate limiting, the SMS worker, and
  shutdown. Track: `sms_outbox` FAILED/AMBIGUOUS counts, readiness flaps, 429
  rates, rotation/replay events.
- **Remaining risks:** the **Eskiz adapter is not implemented** (blocked on a
  verified spec) — **production OTP delivery is not functional**, and the system
  is not production-ready until it is. This now fails **closed** (production
  refuses to start, `/ready` stays 503, the worker won't claim), so it cannot
  silently accept traffic it can't serve. Additionally: the in-process worker
  should be consolidated to one dedicated process at scale; `AMBIGUOUS` SMS
  outcomes and `FAILED(PAYLOAD_DECRYPT)` quarantines require manual
  reconciliation; single-region Redis is an availability dependency for the
  fail-closed auth controls; outbox-key rotation requires a drain (documented).
