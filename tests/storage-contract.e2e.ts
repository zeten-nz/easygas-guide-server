/**
 * EASY GAS — Phase 10B storage provider contract tests.
 *
 *   npm run test:storage
 *
 * Every StorageProvider implementation must satisfy the same contract. Runs
 * the LocalStorageProvider (temp dir) and the S3StorageProvider (against an
 * in-memory fake S3 client — no real AWS) through identical assertions.
 */
import './helpers/test-env'; // pins NODE_ENV=test (setStorageProviderForTesting guard)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalStorageProvider } from '../src/storage/local.provider';
import { S3StorageProvider } from '../src/storage/s3.provider';
import { StorageError, type StorageProvider } from '../src/storage/storage.provider';

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
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function streamToBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Minimal in-memory fake of the S3 client's `send`, covering the 4 commands. */
function fakeS3Client() {
  const objects = new Map<string, { body: Buffer; contentType?: string }>();
  return {
    objects,
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      const name = command.constructor.name;
      const key = command.input.Key as string;
      if (name === 'PutObjectCommand') {
        objects.set(key, { body: Buffer.from(command.input.Body), contentType: command.input.ContentType });
        return {};
      }
      if (name === 'HeadObjectCommand') {
        const o = objects.get(key);
        if (!o) {
          const err = Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
          throw err;
        }
        return { ContentLength: o.body.length, ContentType: o.contentType, ETag: '"etag"' };
      }
      if (name === 'GetObjectCommand') {
        const o = objects.get(key);
        if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        return { Body: Readable.from(o.body) };
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(key);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
}

async function runContract(label: string, provider: StorageProvider): Promise<void> {
  const key = `photos/1/2/${label}-${Date.now()}.png`;
  const data = Buffer.from('hello-evidence-bytes');

  await test(`${label}: put returns verified stat; stat/exists agree`, async () => {
    const stat = await provider.put(key, data, { contentType: 'image/png', sha256: 'abc' });
    assert.equal(stat.size, data.length);
    assert.equal(await provider.exists(key), true);
    const head = await provider.stat(key);
    assert.ok(head && head.size === data.length);
  });

  await test(`${label}: getStream returns the exact bytes`, async () => {
    const got = await streamToBuffer(await provider.getStream(key));
    assert.ok(got.equals(data), 'round-tripped bytes must match');
  });

  await test(`${label}: stat/exists report absence without throwing`, async () => {
    assert.equal(await provider.stat('photos/9/9/missing.png'), null);
    assert.equal(await provider.exists('photos/9/9/missing.png'), false);
  });

  await test(`${label}: getStream on a missing object throws StorageError(NOT_FOUND)`, async () => {
    await assert.rejects(
      provider.getStream('photos/9/9/missing.png'),
      (e) => e instanceof StorageError && e.kind === 'NOT_FOUND',
    );
  });

  await test(`${label}: delete is idempotent (missing delete does not throw)`, async () => {
    await provider.delete(key);
    assert.equal(await provider.exists(key), false);
    await provider.delete(key); // again — no throw
  });

  await test(`${label}: path traversal and absolute keys are rejected`, async () => {
    for (const bad of ['../escape.png', '/etc/passwd', 'a/../../b.png', '']) {
      await assert.rejects(provider.put(bad, data), (e) => e instanceof StorageError && e.kind === 'INVALID_KEY', `key: ${bad}`);
    }
  });
}

async function run(): Promise<void> {
  console.log('\nRunning storage contract tests\n');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'eg-storage-'));
  await runContract('local', new LocalStorageProvider(tmp));
  await runContract('s3', new S3StorageProvider({ bucket: 'test-bucket', region: 'us-east-1', client: fakeS3Client() as never }));

  // Local-specific: an object written under the root really lands inside it.
  await test('local: object is written strictly inside the storage root', async () => {
    const local = new LocalStorageProvider(tmp);
    const k = 'signatures/5/sig.png';
    await local.put(k, Buffer.from('x'));
    await fs.access(path.join(tmp, k)); // exists inside root
  });

  // S3-specific: native errors are normalized (no AWS leakage).
  await test('s3: a timeout error is normalized to StorageError(TIMEOUT)', async () => {
    const failing = {
      async send() {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      },
    };
    const p = new S3StorageProvider({ bucket: 'b', region: 'r', client: failing as never });
    await assert.rejects(p.put('photos/1/1/x.png', Buffer.from('x')), (e) => e instanceof StorageError && e.kind === 'TIMEOUT');
  });

  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
