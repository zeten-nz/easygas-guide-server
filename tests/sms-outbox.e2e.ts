/**
 * EASY GAS — Phase 10C durable SMS outbox / worker / OTP lifecycle tests.
 *
 *   npm run test:sms   (after: npm run test:setup)
 *
 * Deterministic: a controllable in-process provider + manual worker cycles
 * (runOnce) exercise the outbox state machine with no sleeps and no real SMS.
 * Covers: encrypted payload (no plaintext OTP at rest), resend supersede,
 * concurrent resend, delayed worker, expired-message cancel, retry/backoff,
 * permanent + ambiguous outcomes, max attempts, stale-lease recovery, no
 * double-processing, generic API responses, and the deferred Eskiz adapter.
 *
 * Fixtures: user +998990009101, recipients +99899000920x.
 */
import { assertTestDatabase } from './helpers/test-env';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { setSmsProviderForTesting } from '../src/sms';
import { MemoryRedis, setRedisForTesting } from '../src/redis/redis';
import { SmsSendError, type SmsProvider } from '../src/sms/sms.provider';
import { EskizSmsProvider } from '../src/sms/eskiz.provider';
import { runOnce } from '../src/sms/sms.worker';
import { encryptSecret, decryptSecret } from '../src/utils/crypto';

const USER = '+998990009101';
const PASSWORD = 'Sinov-parol-123';

class ControlProvider implements SmsProvider {
  readonly name = 'control';
  behavior: 'ok' | 'retryable' | 'permanent' | 'ambiguous' = 'ok';
  sent: { phone: string; message: string }[] = [];
  async send(phone: string, message: string): Promise<{ providerMessageId: string | null; outcome: 'ACCEPTED' | 'DELIVERED' }> {
    this.sent.push({ phone, message });
    if (this.behavior === 'retryable') throw new SmsSendError('RETRYABLE', 'TEMP_5XX');
    if (this.behavior === 'permanent') throw new SmsSendError('PERMANENT', 'BAD_NUMBER');
    if (this.behavior === 'ambiguous') throw new SmsSendError('AMBIGUOUS', 'TIMEOUT');
    return { providerMessageId: `pm-${this.sent.length}`, outcome: 'ACCEPTED' };
  }
  countFor(recipient: string): number {
    return this.sent.filter((s) => s.phone === recipient).length;
  }
}
const control = new ControlProvider();

let baseUrl = '';
let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { control.behavior = 'ok'; await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.error(`  FAIL  ${name}`); console.error(`        ${err instanceof Error ? err.stack : String(err)}`); }
}

async function http(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Inserts an outbox row directly (full control for worker-mechanics tests). */
async function insertRow(recipient: string, message: string, over: Record<string, unknown> = {}): Promise<number> {
  const [id] = await db('sms_outbox').insert({
    type: 'OTP', recipient, template_key: 'test', payload_cipher: encryptSecret(message),
    status: 'PENDING', attempts: 0, max_attempts: 5,
    next_attempt_at: db.fn.now(), not_after: new Date(Date.now() + 300_000), ...over,
  });
  return id as number;
}
const rowOf = (id: number) => db('sms_outbox').where({ id }).first();

async function cleanupOutbox(): Promise<void> {
  await db('sms_outbox').where('recipient', 'like', '+99899000920%').orWhere('recipient', USER).del();
}

async function run(): Promise<void> {
  setSmsProviderForTesting(control);
  await assertTestDatabase(db);
  await cleanupOutbox();
  await db('sessions').whereIn('user_id', db('users').where('phone', USER).select('id')).del();
  await db('password_resets').where('phone', USER).del();
  await db('users').where('phone', USER).del();

  const roles = await db('roles').select('id', 'code');
  const branch = await db('branches').where({ status: 'ACTIVE' }).first();
  const pw = await bcrypt.hash(PASSWORD, 10);
  await db('users').insert({ password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE', first_name: 'Sms', last_name: 'User', phone: USER, branch_id: branch.id, role_id: roles.find((r: any) => r.code === 'USTA').id });

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning SMS outbox E2E against ${baseUrl}\n`);

  const otpOf = (recipient: string) => {
    const m = [...control.sent].reverse().find((s) => s.phone === recipient);
    return m?.message.match(/\b(\d{6})\b/)?.[1];
  };

  // ---- No plaintext OTP at rest ----
  await test('the outbox stores an ENCRYPTED payload — no plaintext OTP in the DB row', async () => {
    await http('POST', '/api/v1/auth/forgot-password', { phone: USER });
    const row = await db('sms_outbox').where({ recipient: USER, status: 'PENDING' }).orderBy('id', 'desc').first();
    assert.ok(row, 'a PENDING outbox row exists');
    // The row must not contain any 6-digit code in cleartext.
    assert.ok(!/\b\d{6}\b/.test(row.payload_cipher), 'no plaintext OTP in payload_cipher');
    // But it decrypts back to the real message.
    assert.match(decryptSecret(row.payload_cipher), /parolni tiklash kodi: \d{6}/);
  });

  // ---- Generic API response (enumeration-resistant), delivery is async ----
  await test('forgot-password returns a generic response and delivers via the worker', async () => {
    const r = await http('POST', '/api/v1/auth/forgot-password', { phone: USER });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /SMS kod yuborildi/);
    const before = control.countFor(USER);
    await runOnce(); // deliver
    assert.ok(control.countFor(USER) > before, 'the worker delivered the queued message');
    const sent = await db('sms_outbox').where({ recipient: USER, status: 'SENT' }).first();
    assert.ok(sent && sent.provider_message_id, 'row marked SENT with a provider message id');
  });

  // ---- Resend supersedes the prior OTP + cancels its queued SMS ----
  await test('resend supersedes the prior OTP and cancels its still-queued message; only the latest verifies', async () => {
    setRedisForTesting(new MemoryRedis()); // fresh per-phone rate-limit window
    await db('sms_outbox').where({ recipient: USER }).del();
    await db('password_resets').where({ phone: USER }).del();
    await http('POST', '/api/v1/auth/forgot-password', { phone: USER }); // OTP #1 (still PENDING)
    const first = await db('sms_outbox').where({ recipient: USER }).orderBy('id', 'desc').first();
    await http('POST', '/api/v1/auth/forgot-password', { phone: USER }); // OTP #2 supersedes #1
    const firstAfter = await rowOf(first.id);
    assert.equal(firstAfter.status, 'CANCELLED', 'the first queued SMS was superseded/cancelled');
    // Deliver the latest, capture its OTP, verify it works.
    await runOnce();
    const otp2 = otpOf(USER)!;
    const verify = await http('POST', '/api/v1/auth/verify-otp', { phone: USER, otp: otp2 });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
  });

  // ---- Concurrent resend: only one latest valid OTP ----
  await test('concurrent resend requests leave exactly one deliverable (PENDING) OTP', async () => {
    setRedisForTesting(new MemoryRedis()); // fresh per-phone rate-limit window
    await db('sms_outbox').where({ recipient: USER }).del();
    await db('password_resets').where({ phone: USER }).del();
    await Promise.all([
      http('POST', '/api/v1/auth/forgot-password', { phone: USER }),
      http('POST', '/api/v1/auth/forgot-password', { phone: USER }),
      http('POST', '/api/v1/auth/forgot-password', { phone: USER }),
    ]);
    const pending = await db('sms_outbox').where({ recipient: USER, status: 'PENDING' });
    assert.equal(pending.length, 1, `exactly one PENDING OTP message (got ${pending.length})`);
    const validReset = await db('password_resets').where({ phone: USER }).whereNull('consumed_at');
    assert.equal(validReset.length, 1, 'exactly one un-consumed OTP row');
  });

  // ---- Delayed worker still delivers within the window ----
  await test('a delayed worker still delivers a message that is within its age window', async () => {
    const id = await insertRow('+998990009201', 'code 100200 delayed');
    const before = control.countFor('+998990009201');
    await runOnce();
    assert.equal(control.countFor('+998990009201'), before + 1);
    assert.equal((await rowOf(id)).status, 'SENT');
  });

  // ---- Expired queued message is cancelled, never delivered ----
  await test('a message older than its max age is CANCELLED, not delivered', async () => {
    const id = await insertRow('+998990009202', 'code 300400 old', { not_after: new Date(Date.now() - 1000) });
    const before = control.countFor('+998990009202');
    await runOnce();
    assert.equal(control.countFor('+998990009202'), before, 'provider was NOT called for an expired message');
    const row = await rowOf(id);
    assert.equal(row.status, 'CANCELLED');
    assert.equal(row.last_error, 'EXPIRED_BEFORE_SEND');
  });

  // ---- Retryable failure → RETRY (backoff) then success ----
  await test('a retryable failure schedules a RETRY with backoff; a later cycle succeeds', async () => {
    const id = await insertRow('+998990009203', 'code 500600 retry');
    control.behavior = 'retryable';
    await runOnce();
    let row = await rowOf(id);
    assert.equal(row.status, 'RETRY');
    assert.equal(row.attempts, 1);
    assert.ok(new Date(row.next_attempt_at).getTime() > Date.now(), 'backoff scheduled in the future');
    // Make it eligible again and let it succeed.
    await db('sms_outbox').where({ id }).update({ next_attempt_at: db.fn.now() });
    control.behavior = 'ok';
    await runOnce();
    row = await rowOf(id);
    assert.equal(row.status, 'SENT');
    assert.equal(row.attempts, 2);
  });

  // ---- Permanent rejection → FAILED (no retry) ----
  await test('a permanent rejection marks the message FAILED without retry', async () => {
    const id = await insertRow('+998990009204', 'code 700800 perm');
    control.behavior = 'permanent';
    await runOnce();
    const row = await rowOf(id);
    assert.equal(row.status, 'FAILED');
    assert.match(row.last_error, /^PERMANENT:/);
  });

  // ---- Ambiguous timeout → recorded, NOT retried ----
  await test('an ambiguous timeout is recorded (FAILED/AMBIGUOUS) and not blindly retried', async () => {
    const id = await insertRow('+998990009205', 'code 900100 amb');
    control.behavior = 'ambiguous';
    await runOnce();
    const row = await rowOf(id);
    assert.equal(row.status, 'FAILED', 'not left in RETRY (would risk a duplicate send)');
    assert.match(row.last_error, /^AMBIGUOUS:/);
  });

  // ---- Max attempts → FAILED ----
  await test('a message that exhausts its attempts becomes FAILED', async () => {
    const id = await insertRow('+998990009206', 'code 110220 max', { max_attempts: 1 });
    control.behavior = 'retryable';
    await runOnce();
    const row = await rowOf(id);
    assert.equal(row.status, 'FAILED', 'attempts (1) >= max_attempts (1) → FAILED, not RETRY');
    assert.equal(row.attempts, 1);
  });

  // ---- Stale lease recovery ----
  await test('a stale PROCESSING lease is recovered and the message is delivered', async () => {
    const id = await insertRow('+998990009207', 'code 330440 stale', { status: 'PROCESSING', lease_owner: 'dead-worker', lease_expires_at: new Date(Date.now() - 60_000) });
    control.behavior = 'ok';
    await runOnce(); // recoverStaleLeases → RETRY → claim → deliver
    assert.equal((await rowOf(id)).status, 'SENT');
  });

  // ---- No double-processing across two concurrent workers ----
  await test('two concurrent worker cycles never deliver the same row twice', async () => {
    const rcpt = '+998990009208';
    const id = await insertRow(rcpt, 'code 550660 once');
    const before = control.countFor(rcpt);
    await Promise.all([runOnce(), runOnce()]);
    assert.equal(control.countFor(rcpt), before + 1, 'the row was delivered exactly once');
    assert.equal((await rowOf(id)).status, 'SENT');
  });

  // ---- Eskiz adapter is deferred (fail-fast) ----
  await test('the Eskiz adapter constructs but fails fast (pending verified official docs)', async () => {
    const eskiz = new EskizSmsProvider();
    assert.equal(eskiz.name, 'eskiz');
    await assert.rejects(() => eskiz.send('+998900000000', 'x'), /not implemented|pending/i);
  });

  await cleanupOutbox();
  await db('sessions').whereIn('user_id', db('users').where('phone', USER).select('id')).del();
  await db('password_resets').where('phone', USER).del();
  await db('users').where('phone', USER).del();
  server.close();
  await db.destroy();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => { console.error(err); try { await db.destroy(); } catch { /* ignore */ } process.exit(1); });
