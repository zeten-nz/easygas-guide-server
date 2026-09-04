import { env, isProduction } from '../config/env';
import type { SmsProvider } from './sms.provider';
import { ConsoleSmsProvider } from './console.provider';
import { EskizSmsProvider } from './eskiz.provider';

let provider: SmsProvider | null = null;

/** Test-only injection point (tests capture OTP codes via a fake provider). */
export function setSmsProviderForTesting(p: SmsProvider): void {
  if (isProduction) throw new Error('setSmsProviderForTesting is not available in production');
  provider = p;
}

export function getSmsProvider(): SmsProvider {
  if (provider) return provider;

  switch (env.SMS_PROVIDER) {
    case 'console':
      if (isProduction) {
        throw new Error(
          'SMS_PROVIDER=console is a development-only provider and cannot be used in production. ' +
            'Configure a real SMS provider.',
        );
      }
      provider = new ConsoleSmsProvider();
      return provider;
    case 'eskiz':
      // Constructs successfully; send() fails fast until the official Eskiz
      // spec is verified (see eskiz.provider.ts). Config is validated at boot.
      provider = new EskizSmsProvider();
      return provider;
    default:
      throw new Error(
        'No SMS provider configured. Set SMS_PROVIDER in the environment ' +
          '(development supports "console"; production requires "eskiz" with credentials).',
      );
  }
}
