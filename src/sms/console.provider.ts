import type { SmsProvider, SmsSendResult } from './sms.provider';
import crypto from 'node:crypto';
import { env } from '../config/env';

/**
 * DEVELOPMENT-ONLY provider: surfaces the SMS to the local console so a
 * developer can read the OTP, instead of sending a real message. The factory
 * (src/sms/index.ts) refuses to construct it when NODE_ENV=production, so
 * production can never depend on it.
 *
 * The body (which contains the OTP) is written ONLY on NODE_ENV=development and
 * only to stdout directly — never through the structured application logger, so
 * OTP codes never land in shipped/structured logs or audit metadata. In tests a
 * capturing provider is injected instead, so this code never runs there.
 */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';

  async send(phone: string, message: string): Promise<SmsSendResult> {
    if (env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log(`[DEV SMS → ${phone}] ${message}`);
    }
    return { providerMessageId: `dev-${crypto.randomUUID()}`, outcome: 'ACCEPTED' };
  }
}
