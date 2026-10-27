/**
 * EASY GAS — RedisBackend.ensureConnected() unit suite (no Redis, no DB needed).
 *
 *   npm run test:redis-ensure
 *
 * Drives the REAL RedisBackend with a fake ioredis client whose status and
 * connect() outcome the test controls, to pin the readiness-probe contract:
 *   - only the never-connected 'wait' state starts a connection;
 *   - concurrent callers share ONE connect() (single-flight);
 *   - a failed attempt clears the shared promise so a later probe can retry;
 *   - every other status (ready/connecting/reconnecting/connect/close/end) is a
 *     no-op: the probe never reconnects, never resurrects a closed client;
 *   - no event listeners are added and no rejection ever goes unhandled.
 * The live-Redis behaviour is covered by test:redis-int.
 */
import './helpers/test-env';
import assert from 'node:assert/strict';
import { RedisBackend, buildRedisBackend, type RedisClientLike } from '../src/redis/redis';
import { startFakeRespServer } from './helpers/fake-resp-server';

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

type Status = 'wait' | 'connecting' | 'connect' | 'ready' | 'reconnecting' | 'close' | 'end';

/** Minimal controllable stand-in for the ioredis surface RedisBackend touches. */
class FakeClient {
  status: Status;
  connectCalls = 0;
  listenerAdds = 0;
  private pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  constructor(status: Status = 'wait') {
    this.status = status;
  }
  connect(): Promise<void> {
    this.connectCalls += 1;
    this.status = 'connecting';
    return new Promise<void>((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  /** Completes every in-flight connect() successfully. */
  succeed(): void {
    this.status = 'ready';
    for (const p of this.pending.splice(0)) p.resolve();
  }
  /** Fails every in-flight connect(); ioredis would then be retrying on its own. */
  fail(nextStatus: Status = 'reconnecting'): void {
    this.status = nextStatus;
    for (const p of this.pending.splice(0)) p.reject(new Error('connect failed'));
  }
  async ping(): Promise<string> {
    if (this.status !== 'ready') throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    return 'PONG';
  }
  async quit(): Promise<'OK'> {
    this.status = 'end';
    return 'OK';
  }
  disconnect(): void {
    this.status = 'end';
  }
  once(): this {
    this.listenerAdds += 1;
    return this;
  }
  removeListener(): this {
    return this;
  }
}

function backendFor(fake: FakeClient): RedisBackend {
  return new RedisBackend(fake as unknown as RedisClientLike);
}

async function run(): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    await test('cold client (wait): ensureConnected() connects once and the next ping succeeds', async () => {
      const fake = new FakeClient('wait');
      const b = backendFor(fake);
      await assert.rejects(b.ping(), /Stream isn't writeable/); // the bug being fixed: bare ping on a cold client
      const p = b.ensureConnected();
      assert.equal(fake.connectCalls, 1);
      fake.succeed();
      await p;
      assert.equal(await b.ping(), 'PONG');
    });

    await test('20 parallel ensureConnected() calls share ONE connect() and ONE promise', async () => {
      const fake = new FakeClient('wait');
      const b = backendFor(fake);
      const calls = Array.from({ length: 20 }, () => b.ensureConnected());
      assert.equal(fake.connectCalls, 1, 'exactly one connect() for 20 concurrent callers');
      assert.ok(calls.every((c) => c === calls[0]), 'all callers receive the same Promise');
      fake.succeed();
      await Promise.all(calls);
      assert.equal(fake.connectCalls, 1);
      assert.equal(fake.listenerAdds, 0, 'no event listeners are added');
    });

    await test('20 parallel callers on a client that is already connecting do NOT start another connect()', async () => {
      const fake = new FakeClient('wait');
      const b = backendFor(fake);
      const first = b.ensureConnected(); // status is now 'connecting'
      const rest = Array.from({ length: 19 }, () => b.ensureConnected());
      assert.equal(fake.connectCalls, 1);
      fake.succeed();
      await Promise.all([first, ...rest]);
    });

    await test('ready: no-op (no connect, resolves immediately)', async () => {
      const fake = new FakeClient('ready');
      const b = backendFor(fake);
      await b.ensureConnected();
      assert.equal(fake.connectCalls, 0);
      assert.equal(await b.ping(), 'PONG');
    });

    for (const status of ['connecting', 'connect', 'reconnecting', 'close', 'end'] as const) {
      await test(`${status}: no-op — never starts a connection of its own`, async () => {
        const fake = new FakeClient(status);
        const b = backendFor(fake);
        await Promise.all(Array.from({ length: 5 }, () => b.ensureConnected()));
        assert.equal(fake.connectCalls, 0);
        assert.equal(fake.status, status, 'status untouched');
        assert.equal(fake.listenerAdds, 0);
      });
    }

    await test('a failed attempt rejects every waiter, clears the shared promise, and a later probe retries', async () => {
      const fake = new FakeClient('wait');
      const b = backendFor(fake);
      const calls = Array.from({ length: 20 }, () => b.ensureConnected());
      const settled = Promise.allSettled(calls);
      fake.fail('wait'); // attempt fails and the client is back to never-connected
      const results = await settled;
      assert.ok(results.every((r) => r.status === 'rejected'), 'all 20 waiters see the failure');
      assert.equal(fake.connectCalls, 1);

      const retry = b.ensureConnected(); // state was cleared → a NEW attempt
      assert.notEqual(retry, calls[0]);
      assert.equal(fake.connectCalls, 2);
      fake.succeed();
      await retry;
      assert.equal(await b.ping(), 'PONG');
    });

    await test('after a failure ioredis is "reconnecting": the probe stays a no-op and ping fails closed', async () => {
      const fake = new FakeClient('wait');
      const b = backendFor(fake);
      const p = b.ensureConnected();
      fake.fail('reconnecting');
      await assert.rejects(p, /connect failed/);
      await b.ensureConnected(); // must not start a second, competing connect
      assert.equal(fake.connectCalls, 1);
      await assert.rejects(b.ping(), /Stream isn't writeable/);
    });

    await test('graceful shutdown: after quit() (end) ensureConnected() does not resurrect the client', async () => {
      const fake = new FakeClient('ready');
      const b = backendFor(fake);
      await b.quit();
      assert.equal(fake.status, 'end');
      await b.ensureConnected();
      assert.equal(fake.connectCalls, 0);
      assert.equal(fake.status, 'end');
    });

    await test('an abandoned (un-awaited) failing attempt never becomes an unhandled rejection', async () => {
      const fake = new FakeClient('wait');
      const b = backendFor(fake);
      void b.ensureConnected().catch(() => undefined); // caller timed out and moved on
      fake.fail();
      await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setImmediate(r));
      assert.equal(unhandled.length, 0, `unhandled rejections: ${unhandled.map(String).join('; ')}`);
    });

    // ---- REAL ioredis client over a REAL socket (fake RESP server, no Redis needed) ----
    await test('real ioredis: 20 parallel cold ensureConnected()+ping() open exactly ONE TCP connection', async () => {
      const srv = await startFakeRespServer();
      const b = buildRedisBackend(srv.url);
      try {
        const pongs = await Promise.all(
          Array.from({ length: 20 }, async () => {
            await b.ensureConnected!();
            return b.ping();
          }),
        );
        assert.deepEqual(new Set(pongs), new Set(['PONG']));
        assert.equal(srv.connections(), 1, 'one socket for 20 concurrent probes');
        await Promise.all(Array.from({ length: 20 }, () => b.ensureConnected!()));
        assert.equal(srv.connections(), 1, 'a ready client is never reconnected by later probes');
      } finally {
        await b.quit();
        await srv.close();
      }
    });

    await test('real ioredis: unreachable server → ensureConnected() rejects, ping fails closed, no extra connect', async () => {
      const b = buildRedisBackend('redis://127.0.0.1:6399'); // nothing listens here
      try {
        await assert.rejects(b.ensureConnected!());
        await assert.rejects(b.ping()); // fail-closed
        // ioredis is now retrying on its own; the probe must not stack another connect().
        await b.ensureConnected!();
      } finally {
        await b.quit();
      }
    });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.equal(unhandled.length, 0, 'no unhandled rejections during the whole suite');
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
