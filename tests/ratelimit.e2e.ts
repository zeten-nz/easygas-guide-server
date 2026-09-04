/**
 * EASY GAS — Phase 10C Redis + shared rate limiting tests.
 *
 *   npm run test:ratelimit   (after: npm run test:setup)
 *
 * Deterministic: an in-memory RedisLike with an injectable fake clock stands in
 * for shared Redis (no server, no sleeps). Covers atomic window counting, shared
 * counts across two "app instances", fake-clock window expiry, IP-spoofing
 * resistance, phone-key privacy (HMAC, no raw number), the fail-open/closed
 * Redis-unavailable policy, Retry-After, and key isolation.
 */
import './helpers/test-env'; // sets NODE_ENV=test (enables setRedisForTesting)
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { MemoryRedis, setRedisForTesting, type RedisLike } from '../src/redis/redis';
import { createRateLimiter, ipKey, phoneKey } from '../src/middleware/rate-limit.middleware';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.error(`  FAIL  ${name}`); console.error(`        ${err instanceof Error ? err.message : String(err)}`); }
}

function mockReq(over: Partial<Request> & { body?: any } = {}): Request {
  return { method: 'POST', ip: '1.2.3.4', body: {}, headers: {}, ...over } as unknown as Request;
}
interface MockRes { statusCode: number; body: any; headers: Record<string, string>; nexted: boolean }
function mockResNext(): { res: Response; result: MockRes; next: () => void } {
  const result: MockRes = { statusCode: 200, body: null, headers: {}, nexted: false };
  const res = {
    setHeader(k: string, v: string) { result.headers[k.toLowerCase()] = String(v); },
    getHeader(k: string) { return result.headers[k.toLowerCase()]; },
    status(c: number) { result.statusCode = c; return this; },
    json(b: any) { result.body = b; return this; },
  } as unknown as Response;
  const next = () => { result.nexted = true; };
  return { res, result, next };
}

/** RedisLike that always throws (models Redis being unavailable). */
class FailingRedis implements RedisLike {
  readonly kind = 'memory' as const;
  async ping(): Promise<string> { throw new Error('down'); }
  async incrWindow(): Promise<{ count: number; ttlMs: number }> { throw new Error('down'); }
  async get(): Promise<string | null> { throw new Error('down'); }
  async set(): Promise<void> { throw new Error('down'); }
  async del(): Promise<void> { throw new Error('down'); }
  async quit(): Promise<void> { /* noop */ }
}

async function run(): Promise<void> {
  console.log('\nRunning rate-limit / Redis tests\n');

  // ---- MemoryRedis atomic window + fake-clock expiry ----
  await test('MemoryRedis.incrWindow counts atomically and the window expires on the fake clock', async () => {
    let t = 1_000_000;
    const r = new MemoryRedis(() => t);
    assert.deepEqual(await r.incrWindow('k', 1000), { count: 1, ttlMs: 1000 });
    assert.equal((await r.incrWindow('k', 1000)).count, 2);
    assert.equal((await r.incrWindow('k', 1000)).count, 3);
    t += 1001; // advance past the window
    assert.deepEqual(await r.incrWindow('k', 1000), { count: 1, ttlMs: 1000 }, 'window reset after expiry');
    assert.equal(await r.ping(), 'PONG');
  });

  // ---- Shared counts across two app instances ----
  await test('shared store: two limiter instances sharing one Redis share the count', async () => {
    setRedisForTesting(new MemoryRedis());
    const limit = 3;
    const mk = () => createRateLimiter({ name: 'shared', windowMs: 60_000, limit, failMode: 'closed', key: ipKey });
    const instanceA = mk();
    const instanceB = mk();
    const hit = async (limiter: ReturnType<typeof mk>) => {
      const { res, result, next } = mockResNext();
      await limiter(mockReq({ ip: '9.9.9.9' }), res, next);
      return result;
    };
    // 3 allowed total across both instances; the 4th (either instance) is blocked.
    assert.ok((await hit(instanceA)).nexted);
    assert.ok((await hit(instanceB)).nexted);
    assert.ok((await hit(instanceA)).nexted);
    const fourth = await hit(instanceB);
    assert.equal(fourth.nexted, false);
    assert.equal(fourth.statusCode, 429);
    setRedisForTesting(null);
  });

  // ---- Retry-After on 429 ----
  await test('a blocked request returns 429 with Retry-After', async () => {
    setRedisForTesting(new MemoryRedis());
    const limiter = createRateLimiter({ name: 'ra', windowMs: 60_000, limit: 1, failMode: 'closed', key: ipKey });
    const one = mockResNext();
    await limiter(mockReq({ ip: '2.2.2.2' }), one.res, one.next);
    assert.ok(one.result.nexted);
    const two = mockResNext();
    await limiter(mockReq({ ip: '2.2.2.2' }), two.res, two.next);
    assert.equal(two.result.statusCode, 429);
    const ra = Number(two.result.headers['retry-after']);
    assert.ok(ra >= 1 && ra <= 60, `Retry-After present and sane (got ${ra})`);
    assert.equal(two.result.body.error.code, 'TOO_MANY_REQUESTS');
    setRedisForTesting(null);
  });

  // ---- IP spoofing resistance: keys on req.ip, not X-Forwarded-For ----
  await test('rate-limit key uses the trusted req.ip, ignoring a spoofed X-Forwarded-For', () => {
    const a = ipKey(mockReq({ ip: '5.5.5.5', headers: { 'x-forwarded-for': '1.1.1.1' } as any }));
    const b = ipKey(mockReq({ ip: '5.5.5.5', headers: { 'x-forwarded-for': '2.2.2.2' } as any }));
    assert.equal(a, b, 'same trusted IP → same key regardless of forged XFF');
    assert.equal(a, 'ip:5.5.5.5');
  });

  // ---- Phone-key privacy: HMAC, never the raw number ----
  await test('phone rate-limit key is an HMAC — the raw number never appears', () => {
    const k = phoneKey('+998901234567');
    assert.ok(k.startsWith('ph:'));
    assert.ok(!k.includes('901234567') && !k.includes('998901234567'), 'no raw digits in the key');
    // Deterministic + normalization-stable (different formatting → same key).
    assert.equal(k, phoneKey('90 123 45 67'));
  });

  // ---- Redis unavailable: fail CLOSED for auth, fail OPEN for general API ----
  await test('Redis down: a fail-closed limiter blocks (429); a fail-open limiter allows', async () => {
    setRedisForTesting(new FailingRedis());
    const closed = createRateLimiter({ name: 'auth', windowMs: 60_000, limit: 5, failMode: 'closed', key: ipKey });
    const open = createRateLimiter({ name: 'api', windowMs: 60_000, limit: 5, failMode: 'open', key: ipKey });
    const c = mockResNext();
    await closed(mockReq(), c.res, c.next);
    assert.equal(c.result.nexted, false, 'fail-closed blocks when Redis is down');
    assert.equal(c.result.statusCode, 429);
    const o = mockResNext();
    await open(mockReq(), o.res, o.next);
    assert.equal(o.result.nexted, true, 'fail-open allows when Redis is down');
    setRedisForTesting(null);
  });

  // ---- Key isolation: distinct limiter names/keys don't collide ----
  await test('distinct limiter names and keys are isolated (no cross-pollution)', async () => {
    setRedisForTesting(new MemoryRedis());
    const l1 = createRateLimiter({ name: 'one', windowMs: 60_000, limit: 1, failMode: 'closed', key: ipKey });
    const l2 = createRateLimiter({ name: 'two', windowMs: 60_000, limit: 1, failMode: 'closed', key: ipKey });
    const a = mockResNext(); await l1(mockReq({ ip: '7.7.7.7' }), a.res, a.next);
    const b = mockResNext(); await l2(mockReq({ ip: '7.7.7.7' }), b.res, b.next);
    assert.ok(a.result.nexted && b.result.nexted, 'same IP under different limiter names counts separately');
    setRedisForTesting(null);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => { console.error(err); process.exit(1); });
