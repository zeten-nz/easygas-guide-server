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
