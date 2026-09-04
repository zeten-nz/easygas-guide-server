/**
 * EASY GAS — Phase 10C SMS outbox encryption tests.
 *
 *   npm run test:encryption
 *
 * Pure crypto (no DB/server). Verifies the AES-256-GCM versioned envelope, fresh
 * per-message IVs, tag/ciphertext/AAD integrity, key derivation (HKDF subkey +
 * dedicated-key validation), and deterministic key resolution (survives restart).
 */
import './helpers/test-env'; // NODE_ENV=test
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { env } from '../src/config/env';
import { encryptSecret, decryptSecret, resolveSmsOutboxKey, OUTBOX_ENVELOPE_VERSION } from '../src/utils/crypto';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.error(`  FAIL  ${name}`); console.error(`        ${err instanceof Error ? err.message : String(err)}`); }
}

/** Builds a v1 envelope with an explicit key (to test wrong-key decryption). */
function encryptWith(key: Buffer, plaintext: string, aad = ''): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `${OUTBOX_ENVELOPE_VERSION}:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${ct.toString('hex')}`;
}

console.log('\nRunning SMS encryption tests\n');

// ---- Roundtrip ----
test('encrypt → decrypt round-trips the plaintext (versioned envelope)', () => {
  const env1 = encryptSecret('EASY GAS: kod 123456');
  assert.ok(env1.startsWith(`${OUTBOX_ENVELOPE_VERSION}:`), 'envelope is versioned');
  assert.equal(decryptSecret(env1), 'EASY GAS: kod 123456');
});

test('encrypt → decrypt round-trips with bound AAD', () => {
  const aad = 'sms-outbox:v1:OTP:abcdef';
  assert.equal(decryptSecret(encryptSecret('code 654321', aad), aad), 'code 654321');
});

// ---- Fresh IV per message ----
test('identical messages produce different ciphertext (fresh random IV each time)', () => {
  const a = encryptSecret('same');
  const b = encryptSecret('same');
  assert.notEqual(a, b, 'ciphertexts differ');
  const ivA = a.split(':')[1];
  const ivB = b.split(':')[1];
  assert.notEqual(ivA, ivB, 'IVs differ');
  assert.equal(ivA.length, 24, '96-bit IV (24 hex chars)');
});

// ---- Tampering ----
test('ciphertext tampering is rejected (no plaintext returned)', () => {
  const parts = encryptSecret('tamper-me').split(':');
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('00') ? 'ff' : '00'); // flip last ct byte
  assert.throws(() => decryptSecret(parts.join(':')));
});

test('auth-tag tampering is rejected', () => {
  const parts = encryptSecret('tag-tamper').split(':');
  parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('00') ? 'ff' : '00');
  assert.throws(() => decryptSecret(parts.join(':')));
});

test('a wrong AAD is rejected (GCM authenticates the AAD)', () => {
  const ct = encryptSecret('bound', 'aad-A');
  assert.throws(() => decryptSecret(ct, 'aad-B'));
  assert.equal(decryptSecret(ct, 'aad-A'), 'bound');
});

// ---- Wrong key ----
test('a ciphertext encrypted under a different key does not decrypt', () => {
  const otherKey = resolveSmsOutboxKey('a-completely-different-app-key-000000');
  const forged = encryptWith(otherKey, 'secret');
  assert.throws(() => decryptSecret(forged), 'wrong key → tag verification fails');
});

// ---- Malformed envelope ----
test('malformed envelopes are strictly rejected', () => {
  assert.throws(() => decryptSecret('not-an-envelope'));
  assert.throws(() => decryptSecret('v9:aa:bb:cc'), /Unsupported|malformed/i); // bad version
  assert.throws(() => decryptSecret(`${OUTBOX_ENVELOPE_VERSION}:zz:bb:cc`)); // non-hex IV
  assert.throws(() => decryptSecret(`${OUTBOX_ENVELOPE_VERSION}:${'a'.repeat(24)}:${'b'.repeat(30)}:cc`)); // short tag
  assert.throws(() => decryptSecret('')); // empty
});

// ---- Key derivation & validation ----
test('resolveSmsOutboxKey is deterministic (survives restart) and domain-separated', () => {
  const k1 = resolveSmsOutboxKey(env.APP_KEY);
  const k2 = resolveSmsOutboxKey(env.APP_KEY);
  assert.ok(k1.equals(k2), 'same APP_KEY → same key across "restarts"');
  assert.equal(k1.length, 32, '32-byte key');
  assert.ok(!k1.equals(resolveSmsOutboxKey(env.APP_KEY + 'x')), 'different input → different key');
  // Domain separation: the outbox key is not the raw APP_KEY bytes.
  assert.ok(!k1.equals(Buffer.from(env.APP_KEY, 'utf8').subarray(0, 32)));
});

test('a dedicated key is used verbatim; a malformed one is rejected (fail closed)', () => {
  const hex = 'ab'.repeat(32); // 64 hex chars = 32 bytes
  assert.ok(resolveSmsOutboxKey('ignored', hex).equals(Buffer.from(hex, 'hex')));
  const b64 = crypto.randomBytes(32).toString('base64');
  assert.equal(resolveSmsOutboxKey('ignored', b64).length, 32);
  assert.throws(() => resolveSmsOutboxKey('ignored', 'abcd'), /32 bytes/, 'too-short dedicated key rejected');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
