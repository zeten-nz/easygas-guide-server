/**
 * EASY GAS — PM2 process manager configuration.
 * =============================================
 *
 * SAFE ARTIFACT: deploys nothing by itself and contains NO secrets. It only
 * declares how PM2 runs the already-built app (`dist/server.js`, from
 * `npm run build`).
 *
 * SECRETS / ENV LOADING (safe): do NOT put secrets here and do NOT `source` a
 * dotenv file into the shell before starting PM2. The app parses its own env
 * file with dotenv (src/config/env.ts reads the server-root `.env`), which
 * handles values with special characters correctly. Put the filled env at the
 * server root as `.env` (mode 600) — see deploy/.env.production.example. This
 * config only sets NON-SECRET toggles (NODE_ENV, worker flag/port).
 *
 * ---------------------------------------------------------------------------
 * DEFAULT: ONE process — the API.
 *
 * EasyGas uses MANUAL admin password recovery; SMS is DISABLED in the normal
 * configuration (SMS_PROVIDER unset), so NO SMS worker is needed and none is
 * started by default. Starting a second copy of dist/server.js with no distinct
 * PORT would merely collide on env.PORT — so we do not.
 *
 * OPTIONAL: a dedicated SMS worker (only if you enable SMS).
 *
 * The SMS worker runs IN-PROCESS from the same entry point, gated by BOTH
 * SMS_PROVIDER=eskiz (in your .env) AND SMS_WORKER_ENABLED=true (set below). It
 * is enabled ONLY when you opt in with the env flag EG_ENABLE_SMS_WORKER=1 when
 * starting PM2, and it is given its OWN private PORT so its (otherwise unused)
 * HTTP listener never collides with the API. Nginx must NOT route public traffic
 * to that port. Keep the worker at a SINGLE instance (DB-leased claims make extra
 * pollers safe but pointless); do NOT scale it.
 *
 *     # API only (default):
 *     pm2 start deploy/ecosystem.config.cjs
 *     # API + dedicated SMS worker (only meaningful with SMS_PROVIDER=eskiz):
 *     EG_ENABLE_SMS_WORKER=1 pm2 start deploy/ecosystem.config.cjs
 *
 * ---------------------------------------------------------------------------
 * SCALE / AVAILABILITY (be honest):
 *   - This baseline is a SINGLE fork process (instances: 1, exec_mode: 'fork').
 *     `pm2 reload` on a single fork is NOT zero-downtime — the old process is
 *     stopped and a new one started, so there is a brief unavailability window
 *     (the app fails /api/v1/ready during graceful shutdown so a health-checking
 *     proxy/LB drains it, but a single node still has a gap). For true zero-
 *     downtime you need MULTIPLE instances behind the proxy (raise `instances`
 *     or use exec_mode 'cluster', and reload — shared Redis/DB/lease state make
 *     this safe) or a second node.
 *   - All shared state is external and coordinated (Redis rate limits, DB row-lock
 *     session rotation, DB-leased SMS outbox), so scaling out is supported.
 *
 * kill_timeout: the app runs a 25s graceful-shutdown timer on SIGTERM
 * (SHUTDOWN_TIMEOUT_MS in src/server.ts). kill_timeout MUST exceed it so the
 * drain (HTTP → SMS batch → Redis → DB pool) can finish; 30000ms here. The app
 * does NOT signal readiness to PM2 (wait_ready: false) — it just drains on SIGTERM.
 *
 * USAGE:
 *   1. Build:   npm run build
 *   2. Put the real env at the server root as .env (mode 600) — never `source` it.
 *   3. Start:   pm2 start deploy/ecosystem.config.cjs        (API only)
 *   4. Persist: pm2 save && pm2 startup                       (survive reboots)
 *   5. Update:  npm run build && pm2 reload deploy/ecosystem.config.cjs
 *               (single-node: expect a brief gap — see SCALE note above)
 *   Logs: pino JSON on stdout/stderr; PM2 persists them (out_file/error_file).
 *   Rotate with pm2-logrotate or system logrotate.
 *
 * Replace <DEPLOY_DIR> with the absolute path to the server directory on the host
 * (e.g. /srv/easygas/server).
 */

const DEPLOY_DIR = '<DEPLOY_DIR>'; // absolute path to server/ on the host

const COMMON = {
  cwd: DEPLOY_DIR,
  script: 'dist/server.js',
  instances: 1,
  exec_mode: 'fork',
  kill_timeout: 30000, // must exceed the app's 25s graceful-shutdown timer
  wait_ready: false, // the app drains on SIGTERM; it does not process.send('ready')
  autorestart: true,
  max_memory_restart: '512M',
  // Restart-storm guard: back off if the process crashes on boot (e.g.
  // assertProductionConfig() rejecting bad config — fail closed).
  min_uptime: '20s',
  max_restarts: 10,
  restart_delay: 5000,
  time: true,
  merge_logs: true,
};

const apps = [
  {
    ...COMMON,
    name: 'easygas-api',
    // NODE_ENV must be 'production' so the app enforces assertProductionConfig()
    // and sets Secure cookies. Secrets come from the server-root .env (dotenv).
    // The API must NOT run the in-process SMS poller.
    env: { NODE_ENV: 'production', SMS_WORKER_ENABLED: 'false' },
    out_file: `${DEPLOY_DIR}/logs/easygas-api.out.log`,
    error_file: `${DEPLOY_DIR}/logs/easygas-api.err.log`,
  },
];

// OPTIONAL dedicated SMS worker — opt-in ONLY. Enabled by starting PM2 with
// EG_ENABLE_SMS_WORKER=1. It is the SAME dist/server.js with SMS_WORKER_ENABLED
// =true and its OWN private PORT (default 4001) so it never collides with the API.
// It only actually polls when SMS is enabled (SMS_PROVIDER=eskiz in .env);
// otherwise startWorker() is a no-op. Keep this port OFF the Nginx upstream and
// firewalled. Do NOT scale this app beyond one instance.
if (process.env.EG_ENABLE_SMS_WORKER === '1') {
  apps.push({
    ...COMMON,
    name: 'easygas-sms-worker',
    env: {
      NODE_ENV: 'production',
      SMS_WORKER_ENABLED: 'true',
      PORT: process.env.EG_SMS_WORKER_PORT || '4001', // distinct private port — never public
    },
    out_file: `${DEPLOY_DIR}/logs/easygas-sms-worker.out.log`,
    error_file: `${DEPLOY_DIR}/logs/easygas-sms-worker.err.log`,
  });
}

module.exports = { apps };
