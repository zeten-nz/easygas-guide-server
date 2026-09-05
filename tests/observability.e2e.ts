/**
 * EASY GAS — Phase 10F observability tests.
 *   npm run test:observability   (after: npm run test:setup)
 *
 * Verifies (1) log redaction of safety-sensitive + secret fields, (2) the
 * token-gated /metrics endpoint (404 without/with a wrong token, 200 with the
 * right one), and (3) that exposed metrics carry only LOW-CARDINALITY labels
 * (route templates, status classes) — never a raw job id, phone or coordinate.
 */
import { METRICS_TOKEN } from './helpers/metrics-env'; // FIRST — sets env before parse
import './helpers/test-env';
import assert from 'node:assert/strict';
import pino from 'pino';
import { Writable } from 'node:stream';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { redactPaths } from '../src/utils/logger';
import { setSmsProviderForTesting } from '../src/sms';
import { setStorageProviderForTesting } from '../src/storage';
import { MemoryStorageProvider } from './helpers/memory-storage';

let baseUrl = '';
async function http(method: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseUrl}${p}`, { method, headers });
  return { status: res.status, text: await res.text() };
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.stack : String(err)}`);
  }
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  setStorageProviderForTesting(new MemoryStorageProvider());

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\nRunning observability E2E against ${baseUrl}\n`);

  // ---- 1. Log redaction (functional, using the app's real redact config) ----
  await test('logger redacts secrets AND safety-sensitive fields (signature, gps, coords, S3 keys)', () => {
    const chunks: string[] = [];
    const sink = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
    const testLogger = pino({ redact: { paths: redactPaths, censor: '[redacted]' } }, sink);
    testLogger.info(
      {
        password: 'p',
        otp: '123456',
        phone: '+998901112233',
        token: 't',
        csrfToken: 'c',
        signature: 'BASE64SIGNATUREBYTES',
        latitude: 41.311,
        longitude: 69.240,
        gps: { latitude: 41.311, longitude: 69.24 },
        coordinates: '41.3,69.2',
        REDIS_URL: 'rediss://user:pass@host',
        S3_ACCESS_KEY_ID: 'AKIA_SECRET',
        S3_SECRET_ACCESS_KEY: 'shhh',
        METRICS_TOKEN: 'tok',
      },
      'redaction probe',
    );
    const out = chunks.join('');
    for (const leak of ['BASE64SIGNATUREBYTES', '+998901112233', '123456', 'AKIA_SECRET', 'rediss://user:pass@host', '41.311', '69.240']) {
      assert.ok(!out.includes(leak), `leaked sensitive value: ${leak}\n${out}`);
    }
    assert.ok(out.includes('[redacted]'), 'expected redaction markers');
  });

  // ---- 2. Metrics endpoint access control ----
  await test('GET /metrics without a token → 404 (existence not advertised)', async () => {
    const r = await http('GET', '/api/v1/metrics');
    assert.equal(r.status, 404);
  });
  await test('GET /metrics with a WRONG bearer token → 404', async () => {
    const r = await http('GET', '/api/v1/metrics', { authorization: 'Bearer wrong-token-value-xxxxxxxxxx' });
    assert.equal(r.status, 404);
  });
  await test('GET /metrics with the correct bearer token → 200 Prometheus text', async () => {
    const r = await http('GET', '/api/v1/metrics', { authorization: `Bearer ${METRICS_TOKEN}` });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.ok(r.text.includes('easygas_http_requests_total'), 'missing http requests metric');
    assert.ok(r.text.includes('# TYPE easygas_http_request_duration_seconds histogram'), 'missing duration histogram');
    assert.ok(r.text.includes('easygas_readiness_up'), 'missing readiness gauge');
    assert.ok(r.text.includes('easygas_db_pool_connections'), 'missing db pool gauge');
  });

  // ---- 3. Low-cardinality labels: route templates, not raw ids ----
  await test('exposed metrics use route TEMPLATES and status classes — no raw job id', async () => {
    // Hit a parameterised route with a concrete id (unauthenticated → 401).
    await http('GET', '/api/v1/jobs/987654');
    const r = await http('GET', '/api/v1/metrics', { authorization: `Bearer ${METRICS_TOKEN}` });
    assert.ok(r.text.includes('route="/api/v1/jobs/:id"'), `expected templated route label\n${r.text}`);
    assert.ok(!r.text.includes('987654'), 'raw job id leaked into metric labels (high cardinality)');
    assert.ok(/status_class="(2xx|4xx)"/.test(r.text), 'expected status_class labels');
    // No phone-like value should ever appear as a label.
    assert.ok(!/\+998\d{9}/.test(r.text), 'phone number leaked into metrics');
  });

  await db.destroy();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => {
  console.error(err);
  try { await db.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
