import type { Server } from 'node:http';
import { env, isProduction, assertProductionConfig, smsFeatureEnabled } from './config/env';
import { logger } from './utils/logger';
import { db } from './config/database';
import { getSmsProvider, smsCapability, smsStartupProblem } from './sms';
import { getStorageProvider } from './storage';
import { connectRedis, closeRedis } from './redis/redis';
import { startWorker, stopWorker } from './sms/sms.worker';
import { setShuttingDown } from './modules/health/health.service';
import { createApp } from './app';

const SHUTDOWN_TIMEOUT_MS = 25_000; // must be < the PM2 kill timeout (see docs)

async function main(): Promise<void> {
  // Fail fast on misconfiguration.
  if (isProduction) assertProductionConfig();
  // §E — SMS is now an OPT-IN feature (no enabled feature uses it after manual
  // admin recovery replaced OTP). Only when a real provider is explicitly selected
  // do we enforce that it is functional at startup (never boot on the Eskiz stub /
  // console-in-prod). With SMS disabled the provider is never constructed and the
  // outbox worker never starts, so pending legacy messages cannot be delivered
  // (they are cancelled by migration; see 20260908000002_cancel_pending_recovery_sms).
  const smsEnabled = smsFeatureEnabled();
  if (smsEnabled) {
    const smsProblem = smsStartupProblem(smsCapability(), isProduction);
    if (smsProblem) throw new Error(smsProblem);
  }
  await db.raw('SELECT 1');
  await connectRedis();
  const sms = smsEnabled ? getSmsProvider() : null;
  const storage = getStorageProvider();
  logger.info(
    { smsProvider: sms?.name ?? 'disabled', storageProvider: storage.name, env: env.NODE_ENV },
    'Configuration OK',
  );

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info(`EASY GAS API listening on http://localhost:${env.PORT} (${isProduction ? 'production' : env.NODE_ENV})`);
  });

  // The SMS worker only runs when SMS is enabled. In a multi-process PM2
  // deployment it is safe (DB-leased claims), but prefer a single dedicated worker
  // process — see docs/PRODUCTION-RUNTIME-10C.md.
  if (smsEnabled) startWorker();

  installShutdown(server);
}

let shuttingDown = false;
function installShutdown(server: Server): void {
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, 'Second shutdown signal — forcing exit');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown starting');

    // 1. Fail readiness so the proxy stops routing new traffic to us.
    setShuttingDown(true);

    const forceTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
      // 2. Stop accepting new HTTP connections; let in-flight requests finish.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // 3. Stop claiming new SMS work and drain the in-flight batch.
      await stopWorker();
      // 4./5. Close Redis and the DB pool.
      await closeRedis();
      await db.destroy();
      clearTimeout(forceTimer);
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err: (err as Error)?.message }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A fatal init/programming error must not leave the process serving in a bad
  // state. Log and exit non-zero (PM2 restarts the process).
  process.on('uncaughtException', (err) => {
    logger.error({ err: err?.message }, 'uncaughtException — exiting');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: (reason as Error)?.message ?? String(reason) }, 'unhandledRejection — exiting');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Server failed to start');
  process.exit(1);
});
