/**
 * EASY GAS — REAL Redis integration suite (Phase 10F).
 *
 * Unlike the other e2e suites, which run against the in-memory RedisLike
 * (deterministic, no server needed — see src/redis/redis.ts getRedis under
 * NODE_ENV=test), THIS suite exercises the ACTUAL ioredis-backed RedisBackend and
 * the real server-side Lua rate limiter against a LIVE Redis. It proves the things
 * a fake backend cannot: connection-readiness before the first command, real
 * atomic Lua semantics, cross-client shared counters, bounded failure when Redis
 * is down, the fail-closed rate-limit policy, and clean teardown with no leaked
 * handles.
 *
 *   REDIS_TEST_DISPOSABLE=1 REDIS_URL=redis://127.0.0.1:6379 npm run test:redis-int
 *
 * Isolation & safety — it NEVER flushes a database and NEVER touches shared keys:
 *   - A UNIQUE per-run prefix (`itest:<uuid>:`) is pinned as REDIS_KEY_PREFIX
 *     BEFORE env/config/Redis load (helpers/redis-run-prefix), so the APP under
 *     test and every Redis client the suite opens write keys under exactly this
 *     one throwaway namespace — including the rate-limiter's own keys.
 *   - Cleanup deletes ONLY `RUN_PREFIX*` via SCAN+DEL. There is no FLUSHDB/FLUSHALL
 *     and no touching of the shared `eg:*`/`eg:rl:*` namespace, so an accidentally
 *     supplied developer/shared/production REDIS_URL cannot lose data.
 *   - It REQUIRES a real REDIS_URL AND an explicit REDIS_TEST_DISPOSABLE opt-in
 *     (fail-closed; NODE_ENV=test is NOT sufficient).
 * All resources are closed in `finally` on both success and failure; the process
 * is left to exit naturally (no forced process.exit) so a leaked handle surfaces
 * as a hang rather than being hidden.
 */
import { RUN_PREFIX } from './helpers/redis-run-prefix'; // MUST be first: pins REDIS_KEY_PREFIX before env loads
import { assertTestDatabase } from './helpers/test-env'; // NODE_ENV=test + *_test DB (also before env loads)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Redis } from 'ioredis';
import { db } from '../src/config/database';
import { env } from '../src/config/env';
import { createApp } from '../src/app';
import { buildRedisBackend, connectRedis, setRedisForTesting, type RedisLike } from '../src/redis/redis';

const URL = process.env.REDIS_URL;
const DEAD_URL = 'redis://127.0.0.1:6399'; // nothing listens here
// A unique, non-fixture phone per run (the run prefix already isolates its key).
const LOGIN_PHONE = `+99890${String(Date.now()).slice(-7)}`;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

/**
 * Deletes ONLY the keys under THIS run's unique prefix, via SCAN+DEL (never
 * FLUSHDB, never a shared namespace). `client` must be a RAW ioredis client with
 * NO keyPrefix so it matches full keys.
 */
async function scanDelRunPrefix(client: Redis): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${RUN_PREFIX}*`, 'COUNT', 200);
    cursor = next;
    if (keys.length) await client.del(...keys);
  } while (cursor !== '0');
}

let baseUrl = '';
async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function run(): Promise<void> {
  // Fail-closed: this suite is meaningless without a real Redis. Never skip.
  if (!URL) {
    throw new Error(
      'redis-integration REQUIRES a real REDIS_URL (a live Redis). Refusing to run without one — this suite must not be silently skipped.',
    );
  }
  // Fail-closed disposable-target guard. NODE_ENV=test is NOT sufficient: the
  // operator must explicitly assert the REDIS_URL points at a throwaway test
  // instance, so this suite can never touch a developer/shared/production Redis by
  // accident. (We still never FLUSHDB and only ever delete this run's prefix.)
  if (!process.env.REDIS_TEST_DISPOSABLE) {
    throw new Error(
      'redis-integration refuses to run without REDIS_TEST_DISPOSABLE=1 — it writes/deletes keys and must only ever target an explicitly disposable test Redis.',
    );
  }
  await assertTestDatabase(db);

  const backends: RedisLike[] = []; // every RedisBackend we open, closed in finally
  const rawClients: Redis[] = []; // raw ioredis clients, closed in finally
  let server: Server | undefined;
  let sentinelKey: string | undefined; // a key OUTSIDE the run prefix (see cleanup test)

  // Raw admin client (NO keyPrefix) used only for run-prefix SCAN+DEL and reads.
  const admin = new Redis(URL);
  rawClients.push(admin);

  try {
    // Sanity: the APP itself was configured with this run's unique prefix (so the
    // rate limiter's own keys live under it too, not under the shared eg:* space).
    await test('the app + suite share this run\'s unique Redis prefix (env.REDIS_KEY_PREFIX)', async () => {
      assert.equal(env.REDIS_KEY_PREFIX, RUN_PREFIX);
      assert.ok(/^itest:[0-9a-f-]{36}:$/.test(RUN_PREFIX), `unexpected run prefix ${RUN_PREFIX}`);
    });

    // -- 1. Readiness before the first request (req 1 + req 5, healthy path) --
    await test('connect() awaits readiness, and the FIRST command after it succeeds (no race)', async () => {
      const b = buildRedisBackend(URL);
      backends.push(b);
      await b.connect(); // explicit readiness
      const r = await b.incrWindow('ready', 5000); // first command
      assert.equal(r.count, 1);
      assert.equal(r.ttlMs, 5000);
      assert.equal(b.kind, 'redis', 'must be the REAL backend, not the in-memory fake');
    });

    // -- 2. The first-request race is REAL on a healthy Redis without readiness --
    await test('the FIRST command WITHOUT connect() is rejected on healthy Redis; connect() then fixes it', async () => {
      const b = buildRedisBackend(URL);
      backends.push(b);
      await assert.rejects(
        b.incrWindow('norace', 5000),
        /Stream isn't writeable|Connection is closed|enableOfflineQueue/i,
      );
      await b.connect();
      assert.equal((await b.incrWindow('norace', 5000)).count, 1);
    });

    // -- 3. Real Lua: concurrent increments are atomic (req 2) --
    await test('Lua incrWindow: 25 concurrent increments are atomic (1..25, no dup/gap)', async () => {
      const b = buildRedisBackend(URL);
      backends.push(b);
      await b.connect();
      const results = await Promise.all(Array.from({ length: 25 }, () => b.incrWindow('concurrent', 5000)));
      const counts = results.map((r) => r.count).sort((a, x) => a - x);
      assert.deepEqual(counts, Array.from({ length: 25 }, (_, i) => i + 1), 'counts must be exactly 1..25');
      assert.equal(Number(await admin.get(`${RUN_PREFIX}concurrent`)), 25);
    });

    // -- 4. Real Lua: the window TTL is preserved, not reset (req 2) --
    await test('Lua incrWindow: TTL is preserved within the window (a later larger window does not reset it)', async () => {
      const b = buildRedisBackend(URL);
      backends.push(b);
      await b.connect();
      const first = await b.incrWindow('ttl-preserve', 5000);
      assert.equal(first.ttlMs, 5000);
      const second = await b.incrWindow('ttl-preserve', 999_000); // much larger window
      assert.equal(second.count, 2);
      assert.ok(second.ttlMs > 0 && second.ttlMs <= 5000, `expected original ~5000ms TTL kept, got ${second.ttlMs}`);
    });

    // -- 5. Real Lua: a TTL-less key is repaired (req 2) --
    await test('Lua incrWindow: a pre-existing key with NO expiry gets its window TTL repaired', async () => {
      const raw = new Redis(URL, { keyPrefix: RUN_PREFIX }); // suite client — same run prefix
      rawClients.push(raw);
      await raw.set('ttl-repair', '5'); // value, but deliberately no expiry
      assert.equal(await raw.pttl('ttl-repair'), -1, 'precondition: key has no TTL');
      const b = buildRedisBackend(URL);
      backends.push(b);
      await b.connect();
      const r = await b.incrWindow('ttl-repair', 5000);
      assert.equal(r.count, 6, 'incr on the existing value');
      assert.ok(r.ttlMs > 0 && r.ttlMs <= 5000, `TTL must be repaired to the window, got ${r.ttlMs}`);
      assert.ok((await raw.pttl('ttl-repair')) > 0, 'the key now has a positive TTL');
    });

    // -- 6. Real Redis: counters are shared across two independent clients (req 2) --
    await test('two independent RedisBackend clients share the same counter', async () => {
      const b1 = buildRedisBackend(URL);
      const b2 = buildRedisBackend(URL);
      backends.push(b1, b2);
      await b1.connect();
      await b2.connect();
      assert.equal((await b1.incrWindow('shared', 5000)).count, 1);
      assert.equal((await b2.incrWindow('shared', 5000)).count, 2); // sees client 1's increment
      assert.equal((await b1.incrWindow('shared', 5000)).count, 3);
    });

    // -- 7. Redis unavailable → BOUNDED failure (req 3) --
    await test('an unavailable Redis fails within a bounded time (does not hang)', async () => {
      const dead = buildRedisBackend(DEAD_URL);
      backends.push(dead);
      setRedisForTesting(dead);
      const startedAt = Date.now();
      await assert.rejects(connectRedis(1500), /timed out|ECONNREFUSED|connect|closed|refused/i);
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 3000, `connect must fail within the bound, took ${elapsed}ms`);
      setRedisForTesting(null);
    });

    // ---- App-level: real rate limiter through the HTTP stack ----
    server = createApp().listen(0);
    await new Promise<void>((r) => server!.once('listening', r));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const loginBody = { phone: LOGIN_PHONE, password: 'Sinov-parol-123', rememberMe: false };

    // -- 8. Fail-closed policy on a real (dead) backend (req 3) --
    await test('rate limiter fails CLOSED (429) on a login when the real Redis is unavailable', async () => {
      const dead = buildRedisBackend(DEAD_URL);
      backends.push(dead);
      setRedisForTesting(dead); // the app now talks to an unreachable Redis
      const res = await post('/api/v1/auth/login', loginBody);
      assert.equal(res.status, 429, `expected fail-closed 429, got ${res.status}: ${JSON.stringify(res.body)}`);
    });

    // -- 9. First request against HEALTHY Redis (readiness awaited) is NOT limited (req 5) --
    await test('the FIRST login against healthy Redis (readiness awaited) is NOT rate-limited (401, not 429)', async () => {
      const healthy = buildRedisBackend(URL);
      backends.push(healthy);
      setRedisForTesting(healthy);
      await connectRedis(); // establish readiness BEFORE the first request
      // No pre-cleanup needed: the unique run prefix already gives a fresh window.
      const res = await post('/api/v1/auth/login', loginBody);
      assert.notEqual(res.status, 429, 'a readiness-awaited first request must not be rate-limited');
      assert.equal(res.status, 401, `expected 401 bad-credentials (limiter passed), got ${res.status}`);
    });

    // -- 10. Cleanup isolation regression: only RUN_PREFIX keys are removed --
    await test('cleanup deletes ONLY this run prefix — a rate-limit key outside it survives', async () => {
      // A realistic app rate-limit key in the SHARED namespace (what a naive
      // `eg:rl:*` cleanup would have wiped). It must survive our cleanup untouched.
      sentinelKey = `eg:rl:login-ip:sentinel-${randomUUID()}`;
      await admin.set(sentinelKey, 'must-survive');
      const before = await admin.get(sentinelKey);
      // And an in-prefix victim that cleanup SHOULD remove.
      const b = buildRedisBackend(URL);
      backends.push(b);
      await b.connect();
      await b.incrWindow('cleanup-victim', 5000);
      assert.ok((await admin.get(`${RUN_PREFIX}cleanup-victim`)) !== null, 'precondition: in-prefix key exists');

      await scanDelRunPrefix(admin); // delete ONLY RUN_PREFIX*

      assert.equal(await admin.get(sentinelKey), before, 'a key OUTSIDE the run prefix must survive cleanup unchanged');
      assert.equal(await admin.get(`${RUN_PREFIX}cleanup-victim`), null, 'in-prefix keys are removed');

      await admin.del(sentinelKey); // remove ONLY the test-owned sentinel
      sentinelKey = undefined;
    });
  } finally {
    // -- req 4: close everything in finally, on success OR failure. No forced
    //    process.exit — the process must exit naturally once handles are closed.
    setRedisForTesting(null);
    if (admin.status === 'ready') {
      // Delete ONLY this run's prefix (never a shared namespace, never FLUSHDB).
      await scanDelRunPrefix(admin).catch(() => undefined);
      // If the isolation test failed before removing its own sentinel, remove it now.
      if (sentinelKey) await admin.del(sentinelKey).catch(() => undefined);
    }
    for (const b of backends) await b.quit().catch(() => undefined);
    for (const c of rawClients) await c.quit().catch(() => undefined);
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await db.destroy().catch(() => undefined);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('redis-integration crashed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
