import type { SmsProvider } from './sms.provider';
import { logger } from '../utils/logger';

/**
 * DEVELOPMENT-ONLY provider: prints the SMS to the server console instead of
 * sending it. The factory (src/sms/index.ts) refuses to construct this
 * provider when NODE_ENV=production, so production can never depend on it.
 */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';

  async send(phone: string, message: string): Promise<void> {
    logger.warn(`[DEV SMS → ${phone}] ${message}`);
  }
}
