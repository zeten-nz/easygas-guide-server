import crypto from 'node:crypto';

/**
 * Cryptographically-random temporary password for manual admin recovery.
 *
 * An admin reads/copies this ONCE and hands it to a verified employee, who must
 * change it on first login. The alphabet excludes visually ambiguous characters
 * (0/O, 1/l/I) so it can be transcribed reliably; `crypto.randomInt` gives an
 * unbiased index per character. 14 chars over a 54-char alphabet ≈ 80 bits of
 * entropy — far beyond guessing, and it never persists in plaintext (only its
 * bcrypt hash is stored).
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const TEMP_PASSWORD_LENGTH = 14;

export function generateTemporaryPassword(): string {
  let out = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return out;
}
