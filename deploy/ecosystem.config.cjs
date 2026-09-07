/**
 * EASY GAS — PM2 process manager configuration (Phase 10F artifact).
 * ===================================================================
 *
 * SAFE ARTIFACT: this file deploys nothing by itself and contains NO secrets.
 * It only declares how PM2 should run the already-built application
 * (`dist/server.js`, produced by `npm run build`). Real secrets (APP_KEY,
 * DB_PASSWORD, REDIS_URL, S3/Eskiz credentials, ...) MUST come from the OS
 * environment / an env file loaded OUTSIDE PM2 — never from this file. See
 * deploy/.env.production.example and docs/PRODUCTION-RUNTIME-10C.md.
 *
 * ---------------------------------------------------------------------------
 * TWO APPS, ONE ENTRY POINT — why:
 *
 * The SMS worker runs IN-PROCESS from the same entry point (`src/server.ts`
 * calls startWorker(), gated by the SMS_WORKER_ENABLED env var). There is no
 * separate worker entry file. Therefore:
 *
 *   - "easygas-api"        → dist/server.js with SMS_WORKER_ENABLED='false'
 *                            (serves HTTP; does NOT poll the SMS outbox)
 *   - "easygas-sms-worker" → THE SAME dist/server.js with
 *                            SMS_WORKER_ENABLED='true'
 *                            (one dedicated poller for the durable SMS outbox)
 *
 * The worker's claims are DB-leased (per-row conditional UPDATE), so running
 * the worker inside every API instance would be *safe* but wasteful (N
 * concurrent pollers). Running exactly ONE dedicated worker process avoids
 * that. The worker app still starts the HTTP listener (same entry) — that is
 * harmless: keep its port off the Nginx upstream, or give it its own PORT.
 * See "PORT" note below.
 *
 * ---------------------------------------------------------------------------
 * HORIZONTAL SCALE: the API is declared with `instances: 1` and
 * `exec_mode: 'fork'` for a safe, predictable single-node baseline. Scaling
 * out (more instances, or cluster mode, or more nodes) is SUPPORTED because
 * all shared state is external and coordinated:
 *   - rate limiting / abuse counters → shared Redis (REQUIRED in production),
 *   - session rotation               → atomic DB row lock (SELECT ... FOR UPDATE),
 *   - SMS outbox                      → DB-leased claims.
 * To scale the API, raise `instances` (or use exec_mode 'cluster') — but keep
 * the SMS worker at a SINGLE instance. Do NOT scale "easygas-sms-worker".
 *
 * ---------------------------------------------------------------------------
 * kill_timeout: the app runs a 25s graceful-shutdown timer on SIGTERM
 * (SHUTDOWN_TIMEOUT_MS in src/server.ts). PM2 sends SIGTERM, then SIGKILL
 * after kill_timeout. kill_timeout MUST exceed 25000ms so graceful shutdown
 * (drain HTTP → drain SMS batch → close Redis → close DB pool) can finish.
 * We use 30000ms. wait_ready is false: the app does NOT emit process.send
 * ('ready'); it simply closes gracefully on SIGTERM within its 25s window.
 *
 * ---------------------------------------------------------------------------
 * USAGE (operator):
 *   1. Build:   npm run build
 *   2. Load secrets into the environment (do NOT commit the real env file):
 *        set -a; . /srv/easygas/server/deploy/.env.production; set +a
 *      (PM2 captures the current process environment at start time.)
 *   3. Start:   pm2 start deploy/ecosystem.config.cjs
 *   4. Persist: pm2 save && pm2 startup   (survive reboots)
 *   5. Deploy update:  npm run build && pm2 reload deploy/ecosystem.config.cjs
 *
 * Replace <DEPLOY_DIR> below with the absolute path to the server directory
 * on the host (e.g. /srv/easygas/server).
 */

// Non-secret toggles ONLY. Everything sensitive comes from the inherited OS
// environment (step 2 above). NODE_ENV must be 'production' so the app enforces
// assertProductionConfig() (Redis/S3/SMS/proxy checks) and sets Secure cookies.
const NON_SECRET_API_ENV = {
  NODE_ENV: 'production',
  // API instances must NOT run the in-process SMS poller (the dedicated
  // worker app owns that). Value is the literal string 'false' — env.ts treats
  // 'false' / '0' as off.
  SMS_WORKER_ENABLED: 'false',
};

const NON_SECRET_WORKER_ENV = {
  NODE_ENV: 'production',
  // The one dedicated poller. Same entry point as the API.
  SMS_WORKER_ENABLED: 'true',
  // OPTIONAL: give the worker its own private port so its (unused) HTTP
  // listener never collides with the API on a single host. Nginx must NOT
  // route public traffic here. Uncomment and set as needed:
  // PORT: '4001',
};

module.exports = {
  apps: [
    {
      name: 'easygas-api',
      cwd: '<DEPLOY_DIR>', // absolute path to server/ on the host, e.g. /srv/easygas/server
      script: 'dist/server.js',
      // Single-node baseline. Raise instances (or use exec_mode 'cluster') to
      // scale the API — shared Redis is already REQUIRED, so this is safe.
      instances: 1,
      exec_mode: 'fork',
      env: NON_SECRET_API_ENV,
      // Must exceed the app's 25s graceful-shutdown timer (src/server.ts).
      kill_timeout: 30000,
      // The app does not signal readiness to PM2; it just drains on SIGTERM.
      wait_ready: false,
      autorestart: true,
      max_memory_restart: '512M',
      // Restart storm guard: back off if the process crashes on boot
      // (e.g. assertProductionConfig() rejecting bad config — fail closed).
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 5000,
      // Structured (already-redacted) JSON logs from pino go to stdout/stderr;
      // PM2 timestamps and persists them. Point these at your log volume.
      time: true,
      merge_logs: true,
      out_file: '<DEPLOY_DIR>/logs/easygas-api.out.log',
      error_file: '<DEPLOY_DIR>/logs/easygas-api.err.log',
    },
    {
      name: 'easygas-sms-worker',
      cwd: '<DEPLOY_DIR>',
      // SAME entry point as the API — the worker is just server.js with
      // SMS_WORKER_ENABLED='true'. There is no separate worker binary.
      script: 'dist/server.js',
      // MUST stay at exactly one instance — a single dedicated poller. Do NOT
      // scale this app; DB leasing makes extra pollers safe but pointless.
      instances: 1,
      exec_mode: 'fork',
      env: NON_SECRET_WORKER_ENV,
      kill_timeout: 30000,
      wait_ready: false,
      autorestart: true,
      max_memory_restart: '512M',
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
      merge_logs: true,
      out_file: '<DEPLOY_DIR>/logs/easygas-sms-worker.out.log',
      error_file: '<DEPLOY_DIR>/logs/easygas-sms-worker.err.log',
    },
  ],
};
