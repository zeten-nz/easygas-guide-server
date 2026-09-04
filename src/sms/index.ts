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

/**
 * Provider capability (Phase 10C fail-closed). Answers whether the selected SMS
 * provider is actually usable, WITHOUT performing a send:
 *   implemented — the adapter has a working send() (an Eskiz stub is false)
 *   configured  — required credentials/sender are present
 *   ready       — implemented AND configured AND constructible for this env
 * A stub or a console-in-production provider is never `ready`, so startup and
 * readiness fail closed before any OTP traffic.
 */
export interface SmsCapability {
  provider: string;
  implemented: boolean;
  configured: boolean;
  ready: boolean;
}

export function smsCapability(): SmsCapability {
  let p: SmsProvider | null = null;
  try {
    p = getSmsProvider(); // honors a test-injected provider; throws for console-in-prod / unconfigured
  } catch {
    return { provider: env.SMS_PROVIDER ?? 'none', implemented: false, configured: false, ready: false };
  }
  const implemented = p.implemented !== false;
  const configured =
    env.SMS_PROVIDER === 'eskiz'
      ? Boolean(env.ESKIZ_EMAIL && env.ESKIZ_PASSWORD && env.ESKIZ_FROM)
      : true; // console / injected fakes need no external credentials
  return { provider: p.name, implemented, configured, ready: implemented && configured };
}

/**
 * Startup gate: returns a sanitized problem string (no credentials/internals)
 * when a production instance selected a provider that is not usable, else null.
 * Pure over (capability, isProd) so it is unit-testable without flipping env.
 */
export function smsStartupProblem(cap: SmsCapability, isProd: boolean): string | null {
  if (!isProd) return null;
  if (!cap.ready) {
    return `SMS provider "${cap.provider}" is not usable in production (implemented=${cap.implemented}, configured=${cap.configured}) — refusing to start; production OTP delivery is blocked until a functional, configured provider is set.`;
  }
  return null;
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
