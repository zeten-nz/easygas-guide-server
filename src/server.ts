import { env, isProduction } from './config/env';
import { logger } from './utils/logger';
import { db } from './config/database';
import { getSmsProvider } from './sms';
import { createApp } from './app';

async function main() {
  // Fail fast on misconfiguration: DB must be reachable and the SMS provider
  // must be valid for this environment (production refuses dev-only providers).
  await db.raw('SELECT 1');
  const sms = getSmsProvider();
  logger.info({ smsProvider: sms.name, env: env.NODE_ENV }, 'Configuration OK');

  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info(`EASY GAS API listening on http://localhost:${env.PORT} (${isProduction ? 'production' : env.NODE_ENV})`);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Server failed to start');
  process.exit(1);
});
