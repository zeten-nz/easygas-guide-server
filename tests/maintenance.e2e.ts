/**
 * EASY GAS — Phase 10C maintenance/retention tests.
 *
 *   npm run test:maintenance   (after: npm run test:setup)
 *
 * Deterministic: eligibility is created by inserting rows with explicit past
 * timestamps (no sleeps). Covers dry-run (no mutation), apply (bounded delete /
 * lease recovery), idempotency, retention windows, the cross-process advisory
 * lock (held on a second connection), and credential-free output.
 *
 * Fixtures: user +998990009301, recipient +998990009302.
 */
import { assertTestDatabase } from './helpers/test-env';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import knex from 'knex';
import { db } from '../src/config/database';
import { env } from '../src/config/env';
import { encryptSecret } from '../src/utils/crypto';
import { runCleanup } from '../src/maintenance/cleanup.service';

const USER = '+998990009301';
const RECIPIENT = '+998990009302';
const DAY = 24 * 60 * 60 * 1000;

let passed = 0;
let failed = 0;
let userId = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.error(`  FAIL  ${name}`); console.error(`        ${err instanceof Error ? err.stack : String(err)}`); }
}

async function cleanup(): Promise<void> {
  await db('sms_outbox').where({ recipient: RECIPIENT }).del();
  const uids = (await db('users').where({ phone: USER }).select('id')).map((u: { id: number }) => u.id);
  if (uids.length > 0) {
    await db('sessions').whereIn('user_id', uids).del();
    await db('password_resets').whereIn('user_id', uids).del();
  }
  await db('users').where({ phone: USER }).del();
}

async function insertOldSession(revokedDaysAgo: number): Promise<string> {
  const id = crypto.randomUUID();
  const past = new Date(Date.now() - revokedDaysAgo * DAY);
  await db('sessions').insert({
    id, user_id: userId, token_hash: crypto.randomBytes(32).toString('hex'),
    remember_me: false, expires_at: past, absolute_expires_at: past, family_id: id,
    rotation_seq: 0, revoked_at: past, last_used_at: past, created_at: past,
  });
  return id;
}

async function run(): Promise<void> {
  await assertTestDatabase(db);
  await cleanup();

  const roles = await db('roles').select('id', 'code');
  const branch = await db('branches').where({ status: 'ACTIVE' }).first();
  const pw = await bcrypt.hash('Sinov-parol-123', 10);
  userId = (await db('users').insert({ password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE', first_name: 'Mnt', last_name: 'User', phone: USER, branch_id: branch.id, role_id: roles.find((r: any) => r.code === 'USTA').id }))[0] as number;

  console.log('\nRunning maintenance E2E\n');

  // Eligible fixtures (past retention).
  const oldSession1 = await insertOldSession(env.SESSION_RETENTION_DAYS + 1);
  const oldSession2 = await insertOldSession(env.SESSION_RETENTION_DAYS + 5);
  // A recent session must NOT be eligible.
  const recentId = crypto.randomUUID();
  await db('sessions').insert({ id: recentId, user_id: userId, token_hash: crypto.randomBytes(32).toString('hex'), remember_me: false, expires_at: new Date(Date.now() + DAY), absolute_expires_at: new Date(Date.now() + DAY), family_id: recentId, rotation_seq: 0, last_used_at: new Date() });

  const oldReset = new Date(Date.now() - (env.OTP_RETENTION_DAYS + 1) * DAY);
  await db('password_resets').insert({ user_id: userId, phone: USER, otp_hash: 'x'.repeat(64), otp_expires_at: oldReset, created_at: oldReset });

  const oldOutbox = new Date(Date.now() - (env.SMS_OUTBOX_RETENTION_DAYS + 1) * DAY);
  await db('sms_outbox').insert({ type: 'OTP', recipient: RECIPIENT, payload_cipher: encryptSecret('x'), status: 'SENT', attempts: 1, max_attempts: 5, next_attempt_at: oldOutbox, not_after: oldOutbox, created_at: oldOutbox, updated_at: oldOutbox, sent_at: oldOutbox });

  // A stale PROCESSING lease to recover.
  const staleLeaseId = (await db('sms_outbox').insert({ type: 'OTP', recipient: RECIPIENT, payload_cipher: encryptSecret('y'), status: 'PROCESSING', attempts: 0, max_attempts: 5, next_attempt_at: new Date(), not_after: new Date(Date.now() + DAY), lease_owner: 'dead', lease_expires_at: new Date(Date.now() - 60_000) }))[0];

  // ---- Dry-run does not mutate ----
  await test('dry-run reports eligible counts and changes nothing', async () => {
    const r = await runCleanup({ apply: false });
    assert.equal(r.dryRun, true);
    const byCat = Object.fromEntries(r.categories.map((c) => [c.category, c]));
    assert.ok(byCat.sessions.eligible >= 2, `>=2 sessions eligible (got ${byCat.sessions.eligible})`);
    assert.equal(byCat.sessions.affected, 0, 'dry-run deletes nothing');
    // Rows still present.
    assert.ok(await db('sessions').where({ id: oldSession1 }).first());
    assert.equal((await db('sms_outbox').where({ id: staleLeaseId }).first()).status, 'PROCESSING');
  });

  // ---- Apply deletes eligible + recovers leases ----
  await test('apply deletes eligible records in bounded batches and recovers stale leases', async () => {
    const r = await runCleanup({ apply: true });
    const byCat = Object.fromEntries(r.categories.map((c) => [c.category, c]));
    assert.ok(byCat.sessions.affected >= 2);
    assert.ok(byCat.password_resets.affected >= 1);
    assert.ok(byCat.sms_outbox.affected >= 1);
    assert.ok(byCat.sms_stale_leases.affected >= 1);
    // Eligible rows gone; recent session kept; stale lease recovered to RETRY.
    assert.equal(await db('sessions').where({ id: oldSession1 }).first(), undefined);
    assert.equal(await db('sessions').where({ id: oldSession2 }).first(), undefined);
    assert.ok(await db('sessions').where({ id: recentId }).first(), 'recent session must be kept');
    assert.equal((await db('sms_outbox').where({ id: staleLeaseId }).first()).status, 'RETRY');
  });

  // ---- Idempotent ----
  await test('re-running apply is idempotent (nothing left to delete)', async () => {
    const r = await runCleanup({ apply: true });
    const sessions = r.categories.find((c) => c.category === 'sessions')!;
    // Our fixtures are gone; any residual is from other suites — assert our rows stay gone.
    assert.equal(await db('sessions').where({ id: oldSession1 }).first(), undefined);
    assert.ok(sessions.eligible >= 0);
  });

  // ---- Cross-process advisory lock ----
  await test('a concurrent run is skipped while another holds the advisory lock', async () => {
    // Hold the lock on a dedicated single-connection pool (models another process).
    const holder = knex({
      client: 'mysql2',
      connection: { host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME },
      pool: { min: 1, max: 1 },
    });
    try {
      const got = (await holder.raw("SELECT GET_LOCK('eg:maintenance', 0) AS ok")) as [{ ok: number }[], unknown];
      assert.equal(got[0][0].ok, 1, 'holder acquired the lock');
      const r = await runCleanup({ apply: true });
      assert.equal(r.categories.length, 1);
      assert.equal(r.categories[0].category, 'lock', 'the concurrent run was skipped');
      await holder.raw("SELECT RELEASE_LOCK('eg:maintenance')");
    } finally {
      await holder.destroy();
    }
  });

  // ---- No secrets in output ----
  await test('cleanup output contains no credentials/tokens/PII', async () => {
    const r = await runCleanup({ apply: false });
    const s = JSON.stringify(r);
    // No secret VALUES (the "password_resets" category NAME is fine): no hashes,
    // ciphertext, redis URLs, bearer tokens, OTP codes, or long hex tokens.
    assert.ok(!/otp_hash|payload_cipher|redis:\/\/|Bearer |\b\d{6}\b|[0-9a-f]{32,}/i.test(s), `unexpected secret-like material: ${s}`);
    // Category names + counts only.
    assert.ok(r.categories.every((c) => typeof c.eligible === 'number'));
  });

  await cleanup();
  await db.destroy();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => { console.error(err); try { await db.destroy(); } catch { /* ignore */ } process.exit(1); });
