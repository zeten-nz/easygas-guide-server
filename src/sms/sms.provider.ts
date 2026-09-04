/**
 * SMS provider abstraction.
 *
 * Production code depends only on this interface. A real provider (e.g. Eskiz)
 * is added by implementing SmsProvider and registering it in the factory
 * (src/sms/index.ts) — no auth code changes.
 */

export interface SmsSendResult {
  /** Provider-assigned message id (for status lookup / reconciliation), if any. */
  providerMessageId: string | null;
  /**
   * What the provider CONFIRMED. Most gateways only confirm ACCEPTED (queued at
   * the gateway); DELIVERED (handset) requires a later status lookup/callback.
   * We must not claim delivery when only acceptance is confirmed.
   */
  outcome: 'ACCEPTED' | 'DELIVERED';
}

/** Classified failure so the outbox worker can decide retry vs permanent vs ambiguous. */
export type SmsFailureKind = 'RETRYABLE' | 'PERMANENT' | 'AMBIGUOUS';

export class SmsSendError extends Error {
  readonly kind: SmsFailureKind;
  /** Short, sanitized classification code stored in the outbox (never a raw body). */
  readonly code: string;
  constructor(kind: SmsFailureKind, code: string, message?: string) {
    super(message ?? code);
    this.name = 'SmsSendError';
    this.kind = kind;
    this.code = code;
  }
}

export interface SmsProvider {
  /** Machine name, for logs/diagnostics. */
  readonly name: string;

  /**
   * Sends an SMS to a phone number in +998XXXXXXXXX form. Resolves with the
   * provider result on acceptance; throws SmsSendError (classified) on failure.
   * An AMBIGUOUS failure (e.g. a timeout after the request may have been
   * accepted) must NOT be blindly retried by the caller.
   */
  send(phone: string, message: string): Promise<SmsSendResult>;
}
