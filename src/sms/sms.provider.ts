/**
 * SMS provider abstraction.
 *
 * Production code depends only on this interface. A real provider
 * (e.g. Eskiz, Playmobile) is added later by implementing SmsProvider and
 * registering it in the factory (src/sms/index.ts) — no auth code changes.
 */
export interface SmsProvider {
  /** Machine name, for logs/diagnostics. */
  readonly name: string;

  /**
   * Sends an SMS to a phone number in +998XXXXXXXXX form.
   * Must reject on delivery submission failure.
   */
  send(phone: string, message: string): Promise<void>;
}
