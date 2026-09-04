import type { SmsProvider, SmsSendResult } from './sms.provider';

/**
 * Eskiz.uz production SMS adapter — DEFERRED (Phase 10C blocker).
 *
 * The project owner's reference is the Postman documenter
 * (documenter.getpostman.com/view/663428/TVK5eMco), which is a client-rendered
 * SPA and could not be machine-verified during Phase 10C; the only other
 * sources found are third-party wrappers, which are not authoritative. Phase 10C
 * rule 14 / the SMS note forbid implementing a provider's authentication,
 * endpoints or delivery-status semantics from memory or unofficial sources.
 *
 * Rather than guess (which could silently mis-send safety-critical OTPs or claim
 * delivery the gateway never confirmed), this adapter fails fast. The rest of
 * the SMS pipeline (durable outbox, worker, OTP lifecycle) is provider-agnostic
 * and complete, so wiring in the real endpoints against a verified spec is a
 * localized change to this file only.
 *
 * To implement (once the official spec is verified): authenticate at the login
 * endpoint, cache the bearer token (refresh on documented expiry / 401), POST to
 * the send endpoint with the approved sender (ESKIZ_FROM), capture the provider
 * message id, map provider errors to SmsSendError kinds, and treat a request
 * timeout as AMBIGUOUS (never blindly retried). Never log the login, password,
 * bearer token or OTP.
 */
export class EskizSmsProvider implements SmsProvider {
  readonly name = 'eskiz';
  // DEFERRED stub: not functional until the real adapter is written against a
  // verified spec. `implemented=false` makes startup + readiness fail closed
  // (see src/sms/index.ts smsCapability / smsStartupProblem) — production never
  // serves OTP traffic on this stub. Flip to `true` when send() is implemented.
  readonly implemented = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async send(_phone: string, _message: string): Promise<SmsSendResult> {
    throw new Error(
      'Eskiz SMS adapter is not implemented: pending verification of the official Eskiz API documentation ' +
        '(Phase 10C blocker). See src/sms/eskiz.provider.ts and docs/PRODUCTION-RUNTIME-10C.md.',
    );
  }
}
