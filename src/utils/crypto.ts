import crypto from 'node:crypto';
import { env } from '../config/env';

/** Opaque session token: 256 bits of randomness, hex-encoded. */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Session tokens have full 256-bit entropy — plain SHA-256 is sufficient for storage. */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** 6-digit numeric OTP from a CSPRNG. */
export function generateOtp(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * OTPs and reset tokens are HMAC'd with the server-side APP_KEY so a leaked
 * database alone is not enough to forge or brute-force them offline.
 */
export function hmacSecret(value: string): string {
  return crypto.createHmac('sha256', env.APP_KEY).update(value).digest('hex');
}

export function generateResetToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Authenticated symmetric encryption (AES-256-GCM) for short secrets that must
 * survive at rest but never in plaintext — e.g. the rendered OTP SMS body queued
 * in the durable outbox (Phase 10C).
 *
 * Envelope (versioned so the format can evolve): `v1:ivHex:tagHex:ciphertextHex`
 *   - fresh random 96-bit IV per message
 *   - GCM auth tag verified before any plaintext is returned
 *   - optional AAD binds stable metadata (see outbox.service smsAad)
 *
 * Key: a dedicated SMS_OUTBOX_ENCRYPTION_KEY (32 bytes, hex or base64) when set,
 * otherwise an HKDF-SHA256 subkey derived from APP_KEY with a unique context
 * (domain separation — the OTP key is never APP_KEY used raw, nor shared with
 * the OTP/reset HMAC). The key is ALWAYS deterministic — never an ephemeral
 * random key, which would make queued messages undecryptable after a restart.
 */
export const OUTBOX_ENVELOPE_VERSION = 'v1';

/** Decodes a configured key string (64-hex or base64) to raw bytes. */
function decodeKeyMaterial(raw: string): Buffer {
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
}

/**
 * Resolves the 32-byte outbox key. Pure over its inputs so it is unit-testable.
 * Throws on a malformed dedicated key (wrong decoded length) — fail closed.
 */
export function resolveSmsOutboxKey(appKey: string, dedicated?: string): Buffer {
  if (dedicated && dedicated.length > 0) {
    const buf = decodeKeyMaterial(dedicated);
    if (buf.length !== 32) {
      throw new Error('SMS_OUTBOX_ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64)');
    }
    return buf;
  }
  // HKDF-SHA256(ikm=APP_KEY, info="easygas:sms-outbox:v1") — domain-separated.
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(appKey, 'utf8'), Buffer.alloc(0), Buffer.from('easygas:sms-outbox:v1', 'utf8'), 32));
}

let cachedOutboxKey: Buffer | null = null;
function outboxKey(): Buffer {
  if (!cachedOutboxKey) cachedOutboxKey = resolveSmsOutboxKey(env.APP_KEY, env.SMS_OUTBOX_ENCRYPTION_KEY);
  return cachedOutboxKey;
}

export function encryptSecret(plaintext: string, aad = ''): string {
  const iv = crypto.randomBytes(12); // 96-bit nonce, fresh per message
  const cipher = crypto.createCipheriv('aes-256-gcm', outboxKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${OUTBOX_ENVELOPE_VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decryptSecret(payload: string, aad = ''): string {
  const parts = typeof payload === 'string' ? payload.split(':') : [];
  if (parts.length !== 4 || parts[0] !== OUTBOX_ENVELOPE_VERSION) {
    throw new Error('Unsupported or malformed encrypted envelope');
  }
  const [, ivHex, tagHex, ctHex] = parts;
  // Strict shape checks BEFORE touching the cipher (IV 12B, tag 16B, hex ct).
  if (!/^[0-9a-f]{24}$/.test(ivHex) || !/^[0-9a-f]{32}$/.test(tagHex) || !/^[0-9a-f]*$/.test(ctHex)) {
    throw new Error('Malformed IV / auth tag / ciphertext');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', outboxKey(), Buffer.from(ivHex, 'hex'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  // final() throws if the tag (and AAD) do not verify — plaintext is never
  // returned for tampered/wrong-key/wrong-AAD input.
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}
