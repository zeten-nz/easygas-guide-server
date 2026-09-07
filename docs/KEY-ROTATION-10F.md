# Key & Secret Rotation — Phase 10F

Ordered, safe procedures for rotating each production secret. Some rotations have **side effects** —
especially `APP_KEY` — so read the per-secret notes before acting. Rotate in a **maintenance
window** and confirm **readiness** (`/ready`) after each change.

> General rules: rotate one secret at a time; keep the old value until the new one is confirmed
> working; never log secrets (the logger redacts them anyway); update `deploy/.env.production`
> (never commit it); reload the affected process(es) after updating env.

---

## 1. `APP_KEY` — READ THE SIDE EFFECTS FIRST

`APP_KEY` is a master secret. Two subsystems **derive** from it:

| Derives from APP_KEY | Effect of rotation |
|---|---|
| **CSRF token HMAC** (`x-csrf-token` = HMAC of the session cookie) | Rotating **invalidates in-flight CSRF tokens** → active users must re-authenticate / reload to obtain fresh tokens. |
| **SMS outbox encryption** (HKDF-derived subkey) | Rotating makes **existing encrypted outbox payloads undecryptable** → **drain the outbox first**. |

**Not** derived from APP_KEY:

- **Sessions** are opaque DB tokens (SHA-256 at rest), **not** APP_KEY-derived → sessions **survive**
  an APP_KEY rotation.
- OTP/reset tokens are HMAC'd with APP_KEY at rest; in-flight OTP/reset codes issued before rotation
  will no longer verify (short-lived anyway — expect a few users to re-request).

### Ordered procedure

1. **Announce a maintenance window** (users may need to re-auth for CSRF).
2. **Drain the SMS outbox** so no encrypted payload predates the new key:
   - Stop new OTP/SMS traffic (or briefly pause the feature).
   - Let `easygas-sms-worker` process the outbox to empty, or handle terminal rows. Confirm via
     `easygas_sms_outbox_messages{status}` (see `OBSERVABILITY-10F.md`) that no pending/encrypted
     payloads remain.
3. Generate a strong new key and set `APP_KEY` in `deploy/.env.production`.
4. Reload both apps: `pm2 reload easygas-api && pm2 reload easygas-sms-worker`.
5. Confirm `/ready` is OK; verify login (fresh CSRF issues cleanly) and a test OTP round-trip.
6. Expect: users reload/re-auth once; sessions remain valid.

> If the outbox is **not** drained first, any payload encrypted under the old key becomes a terminal
> decrypt failure (`FAILED(PAYLOAD_DECRYPT)`) — quarantined, never sent. Draining avoids losing
> those messages.

---

## 2. Database credentials (`DB_USER` / `DB_PASSWORD`)

1. Create the new credential (or set the new password) on MySQL, keeping the old one active.
2. Ensure the app user retains its **least-privilege GRANTs** (incl. audit: `INSERT, SELECT` on
   `audit_logs`; `INSERT, SELECT, UPDATE` on `audit_chain_heads` — see `AUDIT-INTEGRITY-10F.md` §9).
3. Update `DB_*` in `deploy/.env.production`; `pm2 reload` both apps.
4. Confirm `/ready` DB check passes and `easygas_db_pool_connections` is healthy.
5. Revoke/disable the old credential.

---

## 3. Redis auth (`REDIS_URL` / password)

1. Set the new Redis password (or ACL) with the old still valid if possible.
2. Update `REDIS_URL` in `deploy/.env.production`; `pm2 reload`.
3. Confirm `easygas_redis_up` = 1 and `/ready` Redis check passes. (While mismatched, auth/OTP
   limiters fail **closed** — do it in the window.)
4. Retire the old password.

---

## 4. S3 / object-storage keys (`S3_ACCESS_KEY_ID` / `S3_SECRET`)

1. Create a new access key pair on the storage provider (both pairs valid during overlap).
2. Update `S3_*` in `deploy/.env.production`; `pm2 reload`.
3. Confirm storage readiness and an upload/read round-trip; `easygas_storage_failures_total` flat.
4. Optionally run `npm run reconcile -- --deep` to confirm evidence access.
5. Deactivate the old key pair.

---

## 5. Eskiz SMS credentials (`ESKIZ_*`)

> The real Eskiz adapter is a **fail-closed stub** today (a known production blocker). This
> procedure applies once a real adapter/credential exists.

1. **Drain the outbox first** is *not* required for Eskiz creds alone (only APP_KEY affects payload
   encryption), but do rotate in a window to avoid send failures.
2. Update `ESKIZ_*` in `deploy/.env.production`; `pm2 reload easygas-sms-worker`.
3. Confirm the SMS-config readiness check and a test send; watch
   `easygas_sms_worker_outcomes_total`.
4. Retire the old Eskiz credential.

---

## 6. `METRICS_TOKEN`

1. Generate a new strong token; update `METRICS_TOKEN` in `deploy/.env.production`.
2. `pm2 reload easygas-api`.
3. Update the Prometheus scrape config's bearer token to match.
4. Confirm `/api/v1/metrics` returns 200 with the new token and 404 with the old.

> Reminder: `METRICS_ENABLED=true` requires `METRICS_TOKEN` (production config validation enforces
> this), and Nginx must keep `/metrics` off the public vhost.

---

## 7. `SERVER_REPO_TOKEN` (CI cross-repo E2E)

A **read-only** cross-repo token used only by the client's `e2e-fullstack` workflow.

1. Create a new read-only fine-grained token / PAT scoped to the server repo.
2. Update the **client repo secret** `SERVER_REPO_TOKEN` (GitHub → Settings → Secrets).
3. Trigger `e2e-fullstack` (`workflow_dispatch`) to confirm the server checkout succeeds.
4. Revoke the old token.

---

## 8. Post-rotation checklist

- [ ] `/ready` returns `200` (all checks pass, not shutting down)
- [ ] Metrics healthy (`easygas_redis_up`, DB pool, no new failure counters)
- [ ] A representative flow works (login → CSRF, OTP round-trip if SMS live, an evidence read)
- [ ] `npm run audit:verify` clean (unchanged by rotation, but confirm)
- [ ] Old secret revoked/disabled
- [ ] `deploy/.env.production` updated (and **not** committed); secret manager updated if used
