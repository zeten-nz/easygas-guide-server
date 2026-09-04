import { env, isProduction } from './config/env';
import { logger } from './utils/logger';
import { db } from './config/database';
import { getSmsProvider } from './sms';
import { getStorageProvider } from './storage';
import { createApp } from './app';

async function main() {
  // Fail fast on misconfiguration: DB must be reachable, the SMS provider must
  // be valid for this environment, and the storage provider must be
  // constructible (production refuses the local provider without an explicit
  // override, and s3 requires bucket/region).
  await db.raw('SELECT 1');
  const sms = getSmsProvider();
  const storage = getStorageProvider();
  logger.info({ smsProvider: sms.name, storageProvider: storage.name, env: env.NODE_ENV }, 'Configuration OK');

  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info(`EASY GAS API listening on http://localhost:${env.PORT} (${isProduction ? 'production' : env.NODE_ENV})`);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Server failed to start');
  process.exit(1);
});
