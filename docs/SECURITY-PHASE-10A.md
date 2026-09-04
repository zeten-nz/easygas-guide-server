# Phase 10A — Security & Concurrency Hardening

This document describes the security mechanisms and deployment requirements
introduced in Phase 10A. It is the reference for operators deploying the API.

## CSRF protection

The API authenticates with an HTTP-only session cookie, so it needs CSRF
protection independent of CORS/SameSite. Two layers apply to every
state-changing request (`POST/PUT/PATCH/DELETE`) under `/api/v1`; safe methods
(`GET/HEAD/OPTIONS`) are exempt. Implemented in
`src/middleware/csrf.middleware.ts`, mounted before all routers.

1. **Origin screening** — applies to ALL mutations, including the public auth
   endpoints (covers login-CSRF). If the browser sends an `Origin` header it
   must equal `CLIENT_ORIGIN`; else, if a `Referer` is present, its origin must
   match. Requests with neither header (server-to-server, curl, the test
   suites) pass this layer — browsers always attach `Origin` to the cross-site
   `fetch`/form POSTs that are the attack vector.

2. **Session-bound token** — applies to every mutation carrying a session
   cookie. The client must send
   `x-csrf-token: HMAC-SHA256(APP_KEY, "csrf:" + <raw session cookie value>)`.
   The token is returned only by the `POST /auth/login` and `GET /auth/me`
   JSON responses (same-origin, unreadable cross-site), held in client memory
   (never `localStorage`/cookies), and rotates with the session. A cross-site
   attacker can make the browser send the cookie but cannot read or derive the
   header. Requests without a session cookie need no token (nothing to forge).

There is no per-route exemption list: **cookie present ⇒ token required**, so
no authenticated mutation can bypass the check.

**Frontend:** `client/src/api/client.ts` stores the token in memory
(`setCsrfToken`) and an Axios request interceptor attaches `x-csrf-token` to
every non-GET request. `login`/`fetchMe` set it; `logout` and a 401 clear it.
On reload the `/auth/me` bootstrap re-issues the token before any mutation.

**Failure responses:** `403 CSRF_ORIGIN` (bad origin) or `403 CSRF_TOKEN`
(missing/invalid token).

## Trust proxy & client IP

`TRUST_PROXY_HOPS` (default `0`) sets Express `trust proxy`:

- `0` (development default): `X-Forwarded-For` is **never** trusted; `req.ip`
  is the socket address.
- `N`: exactly `N` trusted reverse proxies in front. Behind a single Nginx set
  `TRUST_PROXY_HOPS=1` so audit logs and rate-limit keys use the real client
  IP from the last proxy-appended `X-Forwarded-For` entry.

Never set it higher than the real number of proxies — each extra hop lets a
client spoof its IP. `req.ip` feeds both audit-log IPs and rate-limit keys.
`express-rate-limit` proxy heuristics are disabled (`validate.trustProxy`,
`validate.xForwardedForHeader`) because trust is configured explicitly here.

**Nginx expectation:** one proxy that sets/rewrites `X-Forwarded-For` (do not
pass a client-supplied value through), e.g.
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, with
`TRUST_PROXY_HOPS=1`.

## OTP / reset-token atomicity

- **OTP verify** (`verifyOtp`): the read → attempt-limit check → increment →
  match → consume sequence runs in one transaction on a `SELECT … FOR UPDATE`
  row. Concurrent requests serialize, so the attempt cap holds and a valid OTP
  is consumed exactly once. The transaction always commits — the attempt
  increment must survive a wrong guess (a rolled-back increment would defeat
  brute-force protection), so the outcome is returned and any error thrown
  after commit.
- **Reset** (`resetPassword`): the token row is locked and its single-use state
  (`reset_used_at`) re-validated **inside** the transaction. Password update +
  token consumption + session revocation + audit commit atomically. Two
  concurrent requests with the same token: the loser blocks on the lock,
  re-reads `reset_used_at` as set, and gets the generic error. Sessions are
  revoked on success.

## Last-active-admin invariant

`blockUser` and role-demoting `updateUser` first call `lockActiveAdminIds`, a
`SELECT … FOR UPDATE` over all active admin rows (ordered by id) that returns
the id set. Because it is a **locking** read, when a contending transaction
unblocks it sees the latest committed set (a plain `COUNT()` would read the
transaction's snapshot and miss the change — the original race). The last-admin
decision is made from that returned set. Consistent lock order (admin set →
target row) prevents deadlocks. DB row locks span processes — correct under
multiple PM2 instances, no process-local mutex.

## Inactive-branch policy

- A user whose branch is `INACTIVE` cannot start a new session (login returns
  the generic credentials error; the real reason `BRANCH_INACTIVE` is audited).
- `requireAuth` refuses inactive-branch users, so existing sessions die
  immediately and cannot create or progress work.
- Deactivating a branch (`setBranchStatus`) revokes every session of its users
  in the same transaction.
- Global roles (`branch_id` NULL — ADMIN/SIFAT) are unaffected and keep
  all-branch read access to the deactivated branch's historical data.

## Test-database safety

Destructive E2E cleanup is fail-closed (`tests/helpers/test-env.ts`, imported
first by every suite):

- Forces `NODE_ENV=test`.
- Selects the test DB as `TEST_DB_NAME` → `<DB_NAME>_test` → `easygas_test`,
  and refuses to start unless the name ends with `_test`.
- `assertTestDatabase(db)` runs before any cleanup and re-checks the **live**
  connection's `SELECT DATABASE()` really ends with `_test`.
- Prints the selected DB name (never credentials).

One-command isolated setup: `npm run test:setup` (creates the `*_test` DB,
migrates, seeds). `npm run test:all` runs every suite; `npm run test:hardening`
runs the Phase 10A suite.

## Error mapping

`src/middleware/error.middleware.ts` maps expected MySQL conflicts to stable
responses without leaking SQL: `errno 1062` → `409 DUPLICATE`; `errno
1213/1205` (deadlock / lock-wait timeout) → `409 CONFLICT_RETRY`. No automatic
retry — these transactions carry audit side effects, so retrying is the
client's decision (the 409 signals it is safe). Full internal detail is logged
with secrets redacted.

## Required environment variables (added in 10A)

| Variable | Default | Purpose |
|---|---|---|
| `TRUST_PROXY_HOPS` | `0` | Reverse-proxy hop count (production behind Nginx: `1`) |
| `TEST_DB_NAME` | — | Isolated E2E database; must end with `_test` |

Existing `APP_KEY` now also keys the CSRF token HMAC (no new secret required).
