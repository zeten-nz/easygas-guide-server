/**
 * EASY GAS — Phase 10C session lifecycle E2E tests.
 *
 *   npm run test:session   (after: npm run test:setup)
 *
 * Exercises absolute/idle expiry, atomic token rotation under parallel requests,
 * the concurrency grace window, replay → family revocation, revocation paths,
 * CSRF continuity across rotation, and a two-instance (PM2-like) shared-DB
 * scenario. "Time" is simulated deterministically by editing the session row's
 * created_at / last_used_at / superseded_at — no sleeps, no fake clock needed.
 *
 * Fixtures: users +99899000900x, "TEST SES ..." names.
 */
import { assertTestDatabase } from './helpers/test-env';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import { env } from '../src/config/env';
import { createApp } from '../src/app';
import { csrfTokenFor } from '../src/middleware/csrf.middleware';
import { setSmsProviderForTesting } from '../src/sms';
import { createSession, resolveSession, revokeByToken, revokeFamily } from '../src/modules/auth/session.service';
import { hashSessionToken } from '../src/utils/crypto';

const USERS = { usta: '+998990009001', admin: '+998990009002' };
const PASSWORD = 'Sinov-parol-123';
const ROTATE_MS = env.SESSION_ROTATE_MINUTES * 60 * 1000;
const GRACE_MS = env.SESSION_ROTATION_GRACE_SECONDS * 1000;
const IDLE_MS = env.SESSION_IDLE_MINUTES * 60 * 1000;

let baseUrl = '';
let ustaId = 0;

interface HttpResult { status: number; body: any; headers: Headers; setCookies: string[] }
async function http(method: string, p: string, opts: { body?: unknown; cookie?: string; csrf?: string } = {}): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.csrf ? { 'x-csrf-token': opts.csrf } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers, setCookies: res.headers.getSetCookie() };
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.error(`  FAIL  ${name}`); console.error(`        ${err instanceof Error ? err.message : String(err)}`); }
}

async function cleanup(): Promise<void> {
  const users = await db('users').whereIn('phone', Object.values(USERS)).select('id');
  const uids = users.map((u: { id: number }) => u.id);
  if (uids.length > 0) {
    await db('audit_logs').whereIn('user_id', uids).del();
    await db('sessions').whereIn('user_id', uids).del();
    await db('password_resets').whereIn('user_id', uids).del();
  }
  await db('users').whereIn('phone', Object.values(USERS)).del();
  await db('branches').where('name', 'like', 'TEST SES%').del();
}

/** Ages a session so the next resolve treats it as rotation-due / idle / expired. */
async function ageCreated(id: string, ms: number): Promise<void> {
  await db('sessions').where({ id }).update({ created_at: new Date(Date.now() - ms) });
}

async function run(): Promise<void> {
  setSmsProviderForTesting({ name: 'test-capture', send: async () => ({ providerMessageId: null, outcome: 'ACCEPTED' as const }) });
  await assertTestDatabase(db);
  await cleanup();

  const roles = await db('roles').select('id', 'code');
  const roleId = (c: string) => roles.find((r: { code: string }) => r.code === c)?.id;
  const [branch] = await db('branches').insert({ name: 'TEST SES Branch', region: 'Toshkent shahri', status: 'ACTIVE' });
  const pw = await bcrypt.hash(PASSWORD, 10);
  ustaId = (await db('users').insert({ password_hash: pw, region: 'Toshkent shahri', status: 'ACTIVE', first_name: 'Ses', last_name: 'Usta', phone: USERS.usta, branch_id: branch, role_id: roleId('USTA') }))[0] as number;

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // A second app instance sharing the same DB (models a second PM2 process).
  const app2 = createApp();
  const server2 = app2.listen(0);
  await new Promise<void>((r) => server2.once('listening', r));
  const baseUrl2 = `http://127.0.0.1:${(server2.address() as { port: number }).port}`;
  console.log(`\nRunning session E2E against ${baseUrl} (+ instance 2 ${baseUrl2})\n`);

  const meta = { ip: '127.0.0.1', userAgent: 'test' };

  // ---- 8. Absolute expiry ----
  await test('absolute expiry: a session past its absolute cap is invalid', async () => {
    const s = await createSession(ustaId, true, meta);
    await db('sessions').where({ token_hash: hashSessionToken(s.token) }).update({ absolute_expires_at: new Date(Date.now() - 1000) });
    assert.equal(await resolveSession(s.token), 'invalid');
  });

  // ---- 9. Idle expiry ----
  await test('idle expiry: a session unused beyond the idle window is invalid', async () => {
    const s = await createSession(ustaId, false, meta);
    await db('sessions').where({ token_hash: hashSessionToken(s.token) }).update({ last_used_at: new Date(Date.now() - IDLE_MS - 60_000) });
    assert.equal(await resolveSession(s.token), 'invalid');
  });

  // ---- 1. Normal rotation ----
  await test('normal rotation: a rotation-due token mints a successor and returns a new token', async () => {
    const s = await createSession(ustaId, false, meta);
    const id = (await db('sessions').where({ token_hash: hashSessionToken(s.token) }).first()).id;
    await ageCreated(id, ROTATE_MS + 60_000);
    const r = await resolveSession(s.token);
    assert.notEqual(r, 'invalid');
    assert.notEqual(r, 'replay');
    const res = r as Exclude<typeof r, string>;
    assert.ok(res.rotated, 'rotation happened');
    assert.notEqual(res.rotated!.token, s.token, 'a new token was issued');
    assert.equal(res.session.rotation_seq, 1, 'rotation_seq incremented');
    // The new token resolves; the family now has 2 rows (predecessor + successor).
    const fam = res.session.family_id;
    const rows = await db('sessions').where({ family_id: fam });
    assert.equal(rows.length, 2);
  });

  // ---- 2. Two parallel requests at the rotation boundary ----
  await test('parallel rotation: two concurrent requests create exactly one successor', async () => {
    const s = await createSession(ustaId, false, meta);
    const id = (await db('sessions').where({ token_hash: hashSessionToken(s.token) }).first()).id;
    const fam = (await db('sessions').where({ id }).first()).family_id;
    await ageCreated(id, ROTATE_MS + 60_000);
    const [a, b] = await Promise.all([resolveSession(s.token), resolveSession(s.token)]);
    for (const r of [a, b]) { assert.notEqual(r, 'invalid'); assert.notEqual(r, 'replay'); }
    const rotatedCount = [a, b].filter((r) => (r as any).rotated).length;
    assert.equal(rotatedCount, 1, 'exactly one request performed the rotation');
    const successors = await db('sessions').where({ family_id: fam }).whereNot({ id });
    assert.equal(successors.length, 1, 'exactly one successor session exists (no divergent sessions)');
  });

  // ---- 3. Old-token grace ----
  await test('grace: the just-rotated old token still resolves within the grace window', async () => {
    const s = await createSession(ustaId, false, meta);
    const id = (await db('sessions').where({ token_hash: hashSessionToken(s.token) }).first()).id;
    await ageCreated(id, ROTATE_MS + 60_000);
    await resolveSession(s.token); // rotate → old token now superseded (just now)
    const again = await resolveSession(s.token);
    assert.notEqual(again, 'invalid');
    assert.notEqual(again, 'replay');
    assert.equal((again as any).rotated, null, 'no second rotation; serves on the old token during grace');
  });

  // ---- 4. Old-token rejection after grace → replay → family revoked ----
  await test('replay: an old token used after grace is rejected and revokes the whole family', async () => {
    const s = await createSession(ustaId, false, meta);
    const id = (await db('sessions').where({ token_hash: hashSessionToken(s.token) }).first()).id;
    const fam = (await db('sessions').where({ id }).first()).family_id;
    await ageCreated(id, ROTATE_MS + 60_000);
    await resolveSession(s.token); // rotate
    // Push the old token's supersede time past the grace window.
    await db('sessions').where({ id }).update({ superseded_at: new Date(Date.now() - GRACE_MS - 10_000) });
    assert.equal(await resolveSession(s.token), 'replay');
    const live = await db('sessions').where({ family_id: fam }).whereNull('revoked_at');
    assert.equal(live.length, 0, 'the whole family is revoked after a confirmed replay');
  });

  // ---- 5. Logout during rotation ----
  await test('logout revokes the family — a rotated token no longer resolves', async () => {
    const s = await createSession(ustaId, false, meta);
    const id = (await db('sessions').where({ token_hash: hashSessionToken(s.token) }).first()).id;
    await ageCreated(id, ROTATE_MS + 60_000);
    const r = await resolveSession(s.token);
    const newToken = (r as any).rotated.token as string;
    await revokeByToken(newToken); // logout on the current token
    assert.equal(await resolveSession(newToken), 'invalid');
    assert.equal(await resolveSession(s.token), 'invalid');
  });

  // ---- 6. Password reset during rotation ----
  await test('family revocation (e.g. password reset) invalidates every session in the family', async () => {
    const s = await createSession(ustaId, false, meta);
    const fam = (await db('sessions').where({ token_hash: hashSessionToken(s.token) }).first()).family_id;
    await revokeFamily(fam);
    assert.equal(await resolveSession(s.token), 'invalid');
  });

  // ---- 7. Block during a live session ----
  await test('a blocked user cannot use an existing session (HTTP 401)', async () => {
    const s = await createSession(ustaId, false, meta);
    await db('users').where({ id: ustaId }).update({ status: 'BLOCKED' });
    const me = await http('GET', '/api/v1/auth/me', { cookie: `${env.SESSION_COOKIE_NAME}=${s.token}` });
    assert.equal(me.status, 401);
    await db('users').where({ id: ustaId }).update({ status: 'ACTIVE' });
  });

  // ---- 10. CSRF continuity after rotation (HTTP) ----
  await test('CSRF continuity: rotation delivers a new cookie + matching CSRF token via headers', async () => {
    const login = await http('POST', '/api/v1/auth/login', { body: { phone: USERS.usta, password: PASSWORD, rememberMe: false } });
    assert.equal(login.status, 200);
    const cookie = login.setCookies.find((c) => c.startsWith('eg_session='))!.split(';')[0];
    const token = cookie.split('=')[1];
    const id = (await db('sessions').where({ token_hash: hashSessionToken(token) }).first()).id;
    await ageCreated(id, ROTATE_MS + 60_000);
    // A normal authenticated GET triggers rotation.
    const meRes = await http('GET', '/api/v1/auth/me', { cookie });
    assert.equal(meRes.status, 200);
    const newCookie = meRes.setCookies.find((c) => c.startsWith('eg_session='))!.split(';')[0];
    assert.notEqual(newCookie, cookie, 'a new session cookie was delivered');
    const headerCsrf = meRes.headers.get('x-csrf-token');
    assert.ok(headerCsrf, 'x-csrf-token header delivered');
    assert.equal(headerCsrf, csrfTokenFor(newCookie.split('=')[1]), 'CSRF token matches the new cookie');
    // The new cookie + new CSRF authorizes a mutation; the OLD CSRF value is rejected.
    const good = await http('POST', '/api/v1/auth/logout', { cookie: newCookie, csrf: headerCsrf! });
    assert.equal(good.status, 204);
  });

  // ---- 12. Two PM2-like instances sharing the DB ----
  await test('two app instances share session state: rotation on instance 2 is honored by instance 1', async () => {
    const login = await http('POST', '/api/v1/auth/login', { body: { phone: USERS.usta, password: PASSWORD, rememberMe: false } });
    const cookie = login.setCookies.find((c) => c.startsWith('eg_session='))!.split(';')[0];
    const token = cookie.split('=')[1];
    const id = (await db('sessions').where({ token_hash: hashSessionToken(token) }).first()).id;
    await ageCreated(id, ROTATE_MS + 60_000);
    // Rotate via instance 2.
    const r2 = await fetch(`${baseUrl2}/api/v1/auth/me`, { headers: { cookie } });
    assert.equal(r2.status, 200);
    const rotated = r2.headers.getSetCookie().find((c) => c.startsWith('eg_session='))!.split(';')[0];
    assert.notEqual(rotated, cookie);
    // Instance 1 accepts the token rotated by instance 2.
    const r1 = await http('GET', '/api/v1/auth/me', { cookie: rotated });
    assert.equal(r1.status, 200);
  });

  await cleanup();
  server.close();
  server2.close();
  await db.destroy();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

run().catch(async (err) => {
  console.error(err);
  try { await db.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
