import { env, isProduction } from '../config/env';
import type { SmsProvider } from './sms.provider';
import { ConsoleSmsProvider } from './console.provider';

let provider: SmsProvider | null = null;

/** Test-only injection point (used by tests/auth.e2e.ts to capture OTP codes). */
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
    default:
      throw new Error(
        'No SMS provider configured. Set SMS_PROVIDER in the environment ' +
          '(development supports "console"; production requires a real provider implementation).',
      );
  }
}
