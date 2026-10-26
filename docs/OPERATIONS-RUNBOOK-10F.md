# Operations Runbook — Phase 10F

Day-2 operations for the EASY GAS server: the PM2 process model (one API process by default, an
optional SMS worker), the Nginx / readiness-based rollout, migrations on deploy, the scheduled jobs,
metrics scraping, log locations, graceful shutdown, and how to read readiness.

> Deploy artifacts already exist — **reference them, do not recreate**:
> `deploy/ecosystem.config.cjs`, `deploy/nginx.example.conf`, `deploy/.env.production.example`,
> `deploy/crontab.example`; `scripts/backup-mysql.sh`, `scripts/backup-evidence.sh`,
> `scripts/restore-mysql.sh`; `docs/BACKUP-RESTORE-10F.md`; `loadtest/smoke.js`,
> `loadtest/README.md`.

---

## 1. Processes (PM2) — `deploy/ecosystem.config.cjs`

**By default PM2 starts ONE process — `easygas-api`.** SMS is disabled in the normal EasyGas
configuration (manual admin password recovery; `SMS_PROVIDER` unset), so no SMS worker is needed and
none is started. A dedicated SMS worker is **optional** and only relevant if you enable SMS.

| App | When it runs | Role | Key env |
|---|---|---|---|
| `easygas-api` | **Always** (default) | HTTP API — serves requests, does **not** run the SMS worker | `SMS_WORKER_ENABLED=false` |
| `easygas-sms-worker` | **Optional, opt-in only** | Dedicated SMS outbox worker on its **own private port** (default `4001`, `EG_SMS_WORKER_PORT`); only actually polls when SMS is enabled (`SMS_PROVIDER=eskiz`) | `SMS_WORKER_ENABLED=true` |

- The optional worker is opted into by starting PM2 with `EG_ENABLE_SMS_WORKER=1`. It runs a single
  instance on a private port that must stay **off** the Nginx upstream and firewalled — never public.
- `kill_timeout` is **30000 ms** — deliberately longer than the app's **25 s** graceful shutdown
  (see §6) so PM2 does not SIGKILL mid-drain.

```bash
pm2 start deploy/ecosystem.config.cjs                         # API only (default)
EG_ENABLE_SMS_WORKER=1 pm2 start deploy/ecosystem.config.cjs  # API + optional SMS worker (only meaningful with SMS_PROVIDER=eskiz)
pm2 status                                 # health
pm2 reload easygas-api                      # reloads — NOT zero-downtime on a single node (see §6)
pm2 logs easygas-api                        # tail logs
pm2 logs easygas-sms-worker                 # only if the optional worker is running
```

---

## 2. Nginx & readiness-based rollout — `deploy/nginx.example.conf`

- **Recommended baseline: same-origin.** One public HTTPS origin where Nginx serves the client
  `dist/` and reverse-proxies `/api` to the private backend, **preserving the `/api/v1` path**; API
  errors never fall back to `index.html`, hashed assets are cached immutable while `index.html` is
  revalidated. Separate-origin (SPA and API on different hosts) is a documented alternative that
  requires `VITE_API_URL` + `CLIENT_ORIGIN` + CORS + CSRF + cookies to all agree. The Vite dev proxy
  is a development convenience, **not** the production server (`npm run build`, let Nginx serve `dist/`).
- Nginx terminates TLS and proxies to `easygas-api`. It must set the correct client-IP headers to
  match the app's `TRUST_PROXY_HOPS` (see the env example) and **must keep `/api/v1/metrics` off
  the public vhost** (scrape only from the trusted internal network — see `OBSERVABILITY-10F.md`).
- **Rollout is readiness-gated:** bring an instance up, wait for **`/ready`** to return `200`, then
  shift traffic. Never route to an instance whose `/ready` is not OK.

```
GET /api/v1/health   → liveness  (is the process up?)
GET /api/v1/ready    → readiness (are DB/Redis/storage/risk-policy OK — plus SMS only when SMS is enabled — and not shutting down?)
```

See §7 for reading readiness.

---

## 3. Migrations on deploy

Run migrations **before** bringing new code into rotation, in a maintenance window when the change
is not backward-compatible.

```bash
npm run migrate:status     # what is applied / pending
npm run migrate            # apply pending migrations
# rollback (only if a deploy must be reverted):
npm run migrate:rollback
```

**Most** migrations are down/up verified in CI, but not all are reversible: some are intentionally
irreversible — e.g. `20260908000002_cancel_pending_recovery_sms` has a deliberate NO-OP `down()`
(cancelled recovery messages must not be revived). Do not assume a blanket rollback is safe; check
the migration first. For legacy evidence, a first-time deploy also runs
`npm run reconcile -- --apply --deep` in the window (see `EVIDENCE-STORAGE-10B.md`).

---

## 4. Scheduled jobs — `deploy/crontab.example`

Install as an external cron file (preferred over any in-process timer, which would run once per PM2
worker). All maintenance CLIs **default to dry-run**; `--apply` is what acts. Every job runs under
`flock -n` so a long run is never doubled up by the next tick; the shell backup job loads `DB_*` from
`.env` via `node scripts/with-env.mjs` (**never** `source` a dotenv file). Each job logs to its own
file under `/var/log/easygas/` — rotate with logrotate.

| When | Job | Command | Notes |
|---|---|---|---|
| 01:00 | MySQL backup | `… node scripts/with-env.mjs bash scripts/backup-mysql.sh` | Integrity-checked gzip dump (+ `.sha256`/`.manifest`); `DB_*` loaded safely via `with-env.mjs` |
| 01:20 | Evidence off-site sync | `EVIDENCE_TOOL=aws DIRECTION=backup APPLY=1 … bash scripts/backup-evidence.sh` | Replicate the private **versioned** bucket off-site; pick ONE tool (aws `s3://` or rclone `remote:bucket`) |
| 02:15 | **Audit chain verify** | `npm run audit:verify` | Read-only; **alert on non-zero exit** (tamper/corruption) |
| 03:30 | Retention cleanup | `npm run cleanup -- --apply` | Expired sessions/OTP/outbox + stale-lease recovery; advisory-locked, idempotent |
| Sun 04:10 | Weekly evidence reconcile | `npm run reconcile -- --deep` | **Ships as DRY-RUN** (no `--apply`); adding `--apply` is a deliberate operator decision after reviewing dry-run output |
| (optional) | Risk-policy sanity | `npm run risk-policy` | Validate an ACTIVE policy exists |

### Off-server audit anchoring

To anchor the audit chain off-server (the only defense against a full-DB rewrite — see
`AUDIT-INTEGRITY-10F.md` §10), run verify with a checkpoint and **export** the checkpoint rows to
immutable off-server storage:

```bash
npm run audit:verify -- --checkpoint "nightly anchor $(date -u +%F)"
# then export the audit_chain_checkpoints rows (or the --json output) off-server
```

> The DB backup and the evidence off-site copy run minutes apart and are **NOT** a transactionally
> consistent pair. Safe recovery relies on **object versioning** on both stores plus a **reconcile**
> at the chosen recovery point (`npm run reconcile`, dry-run first) — see `docs/BACKUP-RESTORE-10F.md`.
> Restore procedure: `scripts/restore-mysql.sh` (dry-run by default; requires `CONFIRM_RESTORE=yes` +
> `APPLY=1`, and refuses non-`_test` prod targets without `FORCE_PROD_RESTORE`). A real drill uses a
> **separate disposable MySQL instance**, not just a `_test` name on a shared server.

---

## 5. Metrics scraping

- Endpoint: **`GET /api/v1/metrics`**, Prometheus text format.
- **Token-gated and off by default.** Set `METRICS_ENABLED=true` and provide the correct
  `Authorization: Bearer <METRICS_TOKEN>`; otherwise the endpoint returns **404**.
- Scrape **only from the trusted internal network**; Nginx keeps `/metrics` off the public vhost.
- Useful series to alert on: `easygas_readiness_up`, `easygas_audit_verification_failures_total`,
  `easygas_storage_failures_total`, `easygas_rate_limit_rejections_total`,
  `easygas_sms_outbox_messages{status=...}`, `easygas_unresolved_blocking_risks`,
  `easygas_db_pool_connections{state=...}`, event-loop lag. Full list in `OBSERVABILITY-10F.md`.

---

## 6. Graceful shutdown (25 s)

On `SIGTERM`/`SIGINT` the app shuts down gracefully within **~25 s**: stop accepting new
connections → drain in-flight requests → stop the SMS worker → close Redis → close the Knex pool.
`/ready` flips to **not-ready** as soon as shutdown begins (shutdown-aware), so a load balancer
stops routing to it. PM2's `kill_timeout` (30 s) is set above 25 s so the drain completes before
any SIGKILL.

Reload honesty: on the **single-fork** baseline, `pm2 reload easygas-api` is **not** zero-downtime —
it stops the old process and starts a new one, so a single node has a brief unavailability gap.
`/ready` flipping to not-ready lets a health-checking proxy/LB drain the node, but that does not
remove the gap on one node. True zero-downtime needs **multiple instances** (raise `instances` / use
`cluster` mode) or a **second node**.

---

## 7. Reading readiness — `/api/v1/ready`

`/ready` aggregates the dependency checks. Each check also surfaces as a metric
(`easygas_readiness_check{check=...}`) and the overall state as `easygas_readiness_up`.

| Check | Not-ready means |
|---|---|
| DB | MySQL unreachable / pool exhausted |
| Redis | Redis down (rate-limit/shared state degraded — auth/OTP limiters fail **closed**) |
| storage | Object storage unreachable |
| SMS config | Gates readiness **only when SMS is enabled** (`SMS_PROVIDER=eskiz`). In the normal config (SMS disabled) the provider capability is reported honestly but does **not** block readiness |
| shutting down | The process has begun graceful shutdown |

A `200` means every check passed and the process is not shutting down. Anything else → keep/return
the instance out of rotation and investigate (see `INCIDENT-RESPONSE-10F.md`).

---

## 8. Log locations

- **Application logs:** PM2 (`pm2 logs`), pino JSON with `x-request-id` correlation and redaction
  (see `OBSERVABILITY-10F.md`). PM2 file paths per `deploy/ecosystem.config.cjs`.
- **Scheduled-job logs:** `/var/log/easygas/{cleanup,audit-verify,reconcile,backup-mysql,backup-evidence}.log`
  (per `deploy/crontab.example`) — rotate with logrotate.

---

## 9. Load testing

`loadtest/smoke.js` (k6) — **refuses to run against production** and requires `ALLOW_LOAD_TEST=1`.
See `loadtest/README.md`. Never point it at production.
