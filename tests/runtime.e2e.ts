/**
 * EASY GAS — Phase 10C runtime tests: liveness, readiness, graceful-shutdown
 * readiness flip, production env validation, and log redaction.
 *
 *   npm run test:runtime   (after: npm run test:setup)
 *
 * Deterministic: dependency failure is simulated by injecting a failing Redis;
 * the shutdown signal is simulated via the readiness flag; env validation runs
 * against the pure validateProductionConfig(); redaction runs a pino logger with
 * the real redact config into a buffer. No real signals, no sleeps.
 */
import './helpers/test-env';
import assert from 'node:assert/strict';
import pino from 'pino';
import { createApp } from '../src/app';
import { env, validateProductionConfig } from '../src/config/env';
import { redactPaths } from '../src/utils/logger';
import { setRedisForTesting, MemoryRedis, type RedisLike } from '../src/redis/redis';
import { setShuttingDown } from '../src/modules/health/health.service';
import { setSmsProviderForTesting, smsCapability, smsStartupProblem, type SmsCapability } from '../src/sms';

let baseUrl = '';
let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.error(`  FAIL  ${name}`); console.error(`        ${err instanceof Error ? err.message : String(err)}`); }
}
async function get(p: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${p}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

class FailingRedis implements RedisLike {
  readonly kind = 'memory' as const;
  async ping(): Promise<string> { throw new Error('down'); }
  async incrWindow(): Promise<{ count: number; ttlMs: number }> { throw new Error('down'); }
  async get(): Promise<string | null> { throw new Error('down'); }
  async set(): Promise<void> { throw new Error('down'); }
  async del(): Promise<void> { throw new Error('down'); }
  async quit(): Promise<void> { /* noop */ }
}

/** A production-valid env baseline; individual tests mutate one field. */
function goodProdEnv(): typeof env {
  return {
    ...env,
    NODE_ENV: 'production',
    APP_KEY: 'Zx9Q2w7Er4Ty6Ui8Op0As1Df3Gh5Jk7Lm',
    TRUST_PROXY_HOPS: 1,
    REDIS_URL: 'redis://cache:6379',
    STORAGE_PROVIDER: 's3',
    S3_BUCKET: 'b',
    S3_REGION: 'r',
    SMS_PROVIDER: 'eskiz',
    ESKIZ_EMAIL: 'a@b.c',
    ESKIZ_PASSWORD: 'secret',
    ESKIZ_FROM: 'EASYGAS',
    CLIENT_ORIGIN: 'https://app.easygas.uz',
    DB_NAME: 'easygas',
    SESSION_ROTATE_MINUTES: 60,
    SESSION_IDLE_MINUTES: 720,
    SESSION_ABSOLUTE_DAYS: 30,
    SESSION_ROTATION_GRACE_SECONDS: 30,
  } as typeof env;
}

async function run(): Promise<void> {
  setRedisForTesting(new MemoryRedis());
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning runtime E2E against ${baseUrl}\n`);

  // ---- Liveness ----
  await test('liveness /health returns ok without touching external dependencies', async () => {
    const r = await get('/api/v1/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
  });

  // ---- Readiness: all healthy ----
  await test('readiness /ready is 200 when DB, Redis, storage and SMS config are healthy', async () => {
    const r = await get('/api/v1/ready');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'ready');
    assert.deepEqual(r.body.checks, { db: true, redis: true, storage: true, sms: true, riskPolicy: true, shuttingDown: false });
  });

  // ---- Readiness: a failed dependency (Redis) → 503 ----
  await test('readiness is 503 when a dependency (Redis) is unavailable', async () => {
    setRedisForTesting(new FailingRedis());
    const r = await get('/api/v1/ready');
    assert.equal(r.status, 503);
    assert.equal(r.body.checks.redis, false);
    setRedisForTesting(new MemoryRedis()); // restore
  });

  // ---- Readiness: flips to not-ready during graceful shutdown ----
  await test('readiness becomes 503 during graceful shutdown (drain), then recovers', async () => {
    setShuttingDown(true);
    let r = await get('/api/v1/ready');
    assert.equal(r.status, 503);
    assert.equal(r.body.checks.shuttingDown, true);
    setShuttingDown(false);
    r = await get('/api/v1/ready');
    assert.equal(r.status, 200);
  });

  // ---- Readiness never leaks internals ----
  await test('readiness response exposes only booleans — no hostnames/creds/stack traces', async () => {
    const r = await get('/api/v1/ready');
    const s = JSON.stringify(r.body);
    assert.ok(!/password|redis:\/\/|Error|at \//i.test(s), 'no secrets or stack traces in the readiness body');
  });

  // ---- Production env validation ----
  await test('validateProductionConfig: a well-formed production env has no problems', () => {
    assert.deepEqual(validateProductionConfig(goodProdEnv()), []);
  });

  await test('validateProductionConfig flags each missing production control', () => {
    const has = (e: any, re: RegExp) => validateProductionConfig(e).some((p) => re.test(p));
    assert.ok(has({ ...goodProdEnv(), REDIS_URL: undefined }, /REDIS_URL/), 'missing Redis flagged');
    assert.ok(has({ ...goodProdEnv(), SMS_PROVIDER: 'console' }, /SMS_PROVIDER/), 'console SMS flagged');
    assert.ok(has({ ...goodProdEnv(), TRUST_PROXY_HOPS: 0 }, /TRUST_PROXY_HOPS/), 'no proxy hop flagged');
    assert.ok(has({ ...goodProdEnv(), STORAGE_PROVIDER: 'local', ALLOW_LOCAL_STORAGE_IN_PRODUCTION: false }, /local/), 'local storage flagged');
    assert.ok(has({ ...goodProdEnv(), CLIENT_ORIGIN: 'http://localhost:5173' }, /CLIENT_ORIGIN/), 'localhost origin flagged');
    assert.ok(has({ ...goodProdEnv(), DB_NAME: 'easygas_test' }, /_test/), 'test DB in prod flagged');
    assert.ok(has({ ...goodProdEnv(), SESSION_ROTATE_MINUTES: 999999 }, /ROTATE/), 'bad session timing flagged');
    assert.ok(has({ ...goodProdEnv(), ESKIZ_PASSWORD: undefined }, /eskiz/i), 'missing Eskiz creds flagged');
  });

  await test('validateProductionConfig refuses a non-_test DB in test mode', () => {
    assert.ok(validateProductionConfig({ ...goodProdEnv(), NODE_ENV: 'test', DB_NAME: 'easygas' } as any).some((p) => /_test/.test(p)));
  });

  // ---- A. SMS provider fail-closed: readiness never 200 for a stub ----
  await test('readiness is 503 when the selected SMS provider is a non-functional stub', async () => {
    const cap0 = smsCapability();
    assert.equal(cap0.ready, true, 'baseline (console in test) is ready');
    // Select an unimplemented (stub) provider.
    setSmsProviderForTesting({ name: 'eskiz-stub', implemented: false, send: async () => { throw new Error('stub'); } });
    assert.equal(smsCapability().ready, false, 'stub provider is not ready');
    const r = await get('/api/v1/ready');
    assert.equal(r.status, 503, 'readiness must not be 200 for a stub provider');
    assert.equal(r.body.checks.sms, false);
    // Restore a functional provider for the remaining tests.
    setSmsProviderForTesting({ name: 'ok', implemented: true, send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
    assert.equal((await get('/api/v1/ready')).status, 200);
  });

  await test('smsStartupProblem rejects production on a stub/console, allows a ready provider and dev', () => {
    const stub: SmsCapability = { provider: 'eskiz', implemented: false, configured: true, ready: false };
    const consoleProd: SmsCapability = { provider: 'console', implemented: true, configured: true, ready: false };
    const ready: SmsCapability = { provider: 'eskiz', implemented: true, configured: true, ready: true };
    assert.ok(smsStartupProblem(stub, true), 'prod + Eskiz stub → startup rejected');
    assert.ok(smsStartupProblem(consoleProd, true), 'prod + console → startup rejected');
    assert.equal(smsStartupProblem(ready, true), null, 'prod + ready provider → allowed');
    assert.equal(smsStartupProblem(stub, false), null, 'dev → allowed');
    // The message carries no credentials/provider internals.
    assert.ok(!/password|token|redis:\/\/|secret/i.test(smsStartupProblem(stub, true)!));
  });

  // ---- Log redaction ----
  await test('the logger redacts secrets (cookies, tokens, OTP, passwords, phone, redis url)', () => {
    const chunks: string[] = [];
    const testLogger = pino({ redact: { paths: redactPaths, censor: '[redacted]' } }, { write: (s: string) => { chunks.push(s); } } as any);
    testLogger.info(
      {
        password: 'hunter2',
        otp: '123456',
        token: 'sess-tok-abc',
        csrfToken: 'csrf-abc',
        REDIS_URL: 'redis://user:pass@host:6379',
        ESKIZ_PASSWORD: 'eskiz-secret',
        req: { headers: { cookie: 'eg_session=raw', authorization: 'Bearer xyz', 'x-csrf-token': 'csrf-raw' }, body: { otp: '654321', phone: '+998901234567' } },
      },
      'secrets',
    );
    const out = chunks.join('');
    for (const secret of ['hunter2', '123456', 'sess-tok-abc', 'csrf-abc', 'user:pass', 'eskiz-secret', 'eg_session=raw', 'Bearer xyz', '654321', '+998901234567']) {
      assert.ok(!out.includes(secret), `secret leaked: ${secret}`);
    }
    assert.ok(out.includes('[redacted]'), 'redaction applied');
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => { console.error(err); process.exit(1); });
