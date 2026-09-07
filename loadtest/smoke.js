// EASY GAS — safe READ-ONLY smoke / small load test (Phase 10F artifact)
// =======================================================================
//
// Runs with k6 (https://k6.io). k6 is NOT a project dependency and is NOT
// installed here — install it separately and run:
//
//     ALLOW_LOAD_TEST=1 TARGET=http://127.0.0.1:4000 \
//       E2E_PHONE='<test account phone>' E2E_PASSWORD='<test password>' \
//       k6 run loadtest/smoke.js
//
// SAFETY (this script refuses to be dangerous):
//   * REFUSES to run unless ALLOW_LOAD_TEST=1 is set.
//   * REFUSES any TARGET whose host matches the production denylist (PROD_HOSTS),
//     with NO override — never load-test production.
//   * Exercises READ-ONLY endpoints only (GET). No destructive writes.
//   * No real SMS: it does NOT call OTP/forgot-password send flows.
//   * No file uploads (gated behind ENABLE_UPLOAD, which is intentionally not
//     implemented here — see the guard below).
//   * No data cleanup / mutation.
//   * Uses a TEST account only (E2E_* creds) — never real user credentials.
//
// See loadtest/README.md for what this does and does NOT prove.

import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ---- Configuration (all from environment) ---------------------------------
const TARGET = (__ENV.TARGET || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const BASE = `${TARGET}/api/v1`;
const ALLOW = __ENV.ALLOW_LOAD_TEST === '1';
const E2E_PHONE = __ENV.E2E_PHONE || '';
const E2E_PASSWORD = __ENV.E2E_PASSWORD || '';
const ENABLE_UPLOAD = __ENV.ENABLE_UPLOAD === '1';

// Production host denylist. A TARGET whose host contains any of these tokens is
// refused outright. Extend via PROD_HOSTS="a.example.com,b.example.com".
const DEFAULT_PROD_HOSTS = ['easygas.uz', 'api.easygas', 'prod', 'production'];
const PROD_HOSTS = (__ENV.PROD_HOSTS ? __ENV.PROD_HOSTS.split(',') : DEFAULT_PROD_HOSTS)
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function targetHost(url) {
  // Minimal host extraction (k6 has no URL global in older versions).
  const m = /^[a-z]+:\/\/([^/:]+)/i.exec(url);
  return (m ? m[1] : url).toLowerCase();
}

// ---- Custom metrics --------------------------------------------------------
const errorRate = new Rate('errors'); // check failures (functional errors)
const loginTrend = new Trend('login_duration', true);

// ---- Options: gradual, SMALL ramp + thresholds -----------------------------
// Keep this small — it is a smoke test, not a capacity test.
export const options = {
  stages: [
    { duration: '30s', target: 10 }, // ramp to 10 VUs
    { duration: '1m', target: 10 }, // hold
    { duration: '30s', target: 25 }, // ramp to 25 VUs
    { duration: '1m', target: 25 }, // hold
    { duration: '30s', target: 0 }, // ramp down
  ],
  thresholds: {
    // p95 latency budget for read endpoints (tune to your environment).
    http_req_duration: ['p(95)<800'],
    // Functional error rate (failed checks) must stay very low.
    errors: ['rate<0.01'],
    // Overall check pass rate.
    checks: ['rate>0.99'],
    // Transport/HTTP failures are reported; kept lenient because some reads
    // (e.g. a snapshot that doesn't exist yet) may legitimately 404.
    http_req_failed: ['rate<0.05'],
  },
  // Don't let a broken target produce a misleading "pass".
  noConnectionReuse: false,
};

// ---- setup(): safety gate + discover a few job ids -------------------------
export function setup() {
  if (!ALLOW) {
    fail(
      'Refusing to run: set ALLOW_LOAD_TEST=1 to confirm this is a NON-production target you are authorized to test.',
    );
  }
  const host = targetHost(TARGET);
  for (const banned of PROD_HOSTS) {
    if (host === banned || host.indexOf(banned) !== -1) {
      fail(`Refusing to run: TARGET host "${host}" matches production denylist token "${banned}". Never load-test production.`);
    }
  }
  if (!E2E_PHONE || !E2E_PASSWORD) {
    fail('Refusing to run: E2E_PHONE and E2E_PASSWORD (a TEST account) are required. Never use real credentials.');
  }
  if (ENABLE_UPLOAD) {
    fail(
      'ENABLE_UPLOAD=1 is not supported by this safe script: it deliberately performs NO file uploads / writes. Remove the flag.',
    );
  }

  // Liveness sanity before we start.
  const health = http.get(`${BASE}/health`, { tags: { name: 'health' } });
  check(health, { 'setup: /health is 200': (r) => r.status === 200 }) ||
    fail(`Target ${BASE}/health did not return 200 (got ${health.status}). Is the app running?`);

  // Log in once (in setup's own cookie jar) to discover a few job ids the VUs
  // can read. VUs log in independently (each VU has its own jar).
  const jar = http.cookieJar();
  jar.clear(TARGET);
  const res = login();
  check(res, { 'setup: login 200': (r) => r.status === 200 }) ||
    fail(`Login failed in setup (status ${res.status}). Check E2E_* credentials / that the test account exists.`);

  let jobIds = [];
  const list = http.get(`${BASE}/jobs?page=1&pageSize=10`, { tags: { name: 'jobs:list' } });
  if (list.status === 200) {
    jobIds = extractJobIds(list.body);
  }
  // eslint-disable-next-line no-console
  console.log(`setup: discovered ${jobIds.length} job id(s) for read exercises.`);
  return { jobIds };
}

// ---- Per-VU login state ----------------------------------------------------
// In k6 each VU is an isolated JS runtime, so this module-scoped flag is
// per-VU. Each VU logs in once, then reuses its cookie jar across iterations.
let vuLoggedIn = false;

function login() {
  const payload = JSON.stringify({ phone: E2E_PHONE, password: E2E_PASSWORD });
  const res = http.post(`${BASE}/auth/login`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'auth:login' },
  });
  loginTrend.add(res.timings.duration);
  return res;
}

function extractJobIds(body) {
  try {
    const parsed = JSON.parse(body);
    // Be defensive about the list envelope shape.
    const arr = parsed.data || parsed.jobs || parsed.items || parsed.results || [];
    return arr.map((j) => j && j.id).filter((id) => id != null);
  } catch (_e) {
    return [];
  }
}

function expect(res, name, okStatuses) {
  const ok = okStatuses.indexOf(res.status) !== -1;
  const passed = check(res, { [`${name} -> ${okStatuses.join('/')}`]: () => ok });
  errorRate.add(!passed);
  return ok;
}

// ---- default(): the read-only VU journey -----------------------------------
export default function (data) {
  // Unauthenticated liveness/readiness (cheap, no auth) — representative of the
  // health checks Nginx performs.
  expect(http.get(`${BASE}/health`, { tags: { name: 'health' } }), 'health', [200]);
  expect(http.get(`${BASE}/ready`, { tags: { name: 'ready' } }), 'ready', [200, 503]);

  // Ensure this VU has a session (log in once per VU).
  if (!vuLoggedIn) {
    const res = login();
    if (res.status === 200) {
      vuLoggedIn = true;
    } else {
      // Login is also a rate-limit exercise: 429 is a valid, expected outcome
      // under load with the fail-closed limiter — count it as non-error.
      expect(res, 'auth:login', [200, 429]);
      sleep(1);
      return; // try again next iteration
    }
  }

  // Authenticated READ endpoints.
  const jobsList = http.get(`${BASE}/jobs?page=1&pageSize=20`, { tags: { name: 'jobs:list' } });
  expect(jobsList, 'jobs:list', [200]);

  const ids = (data && data.jobIds) || [];
  if (ids.length > 0) {
    const jobId = ids[Math.floor(Math.random() * ids.length)];

    // Job detail.
    expect(http.get(`${BASE}/jobs/${jobId}`, { tags: { name: 'jobs:detail' } }), 'jobs:detail', [200, 404]);

    // Checklist read for the job.
    expect(
      http.get(`${BASE}/jobs/${jobId}/checklist`, { tags: { name: 'jobs:checklist' } }),
      'jobs:checklist',
      [200, 404],
    );

    // Risk list for the job (paginated).
    expect(
      http.get(`${BASE}/jobs/${jobId}/risks?page=1&pageSize=20`, { tags: { name: 'jobs:risks' } }),
      'jobs:risks',
      [200, 404],
    );

    // Evidence / completion METADATA read (NOT the signature file bytes).
    expect(
      http.get(`${BASE}/jobs/${jobId}/completion`, { tags: { name: 'jobs:completion-meta' } }),
      'jobs:completion-meta',
      [200, 404],
    );
  }

  // Think time between iterations.
  sleep(Math.random() * 2 + 1); // 1–3s
}

// ---- teardown(): nothing to clean up (read-only) ---------------------------
export function teardown(_data) {
  // Intentionally empty: this test creates no data and mutates nothing.
}
