# CI & Release Automation — Phase 10F

Continuous-integration workflows for both repositories, the cross-repo full-stack E2E strategy
(and why it is separate), the action-pinning posture, and the **recommended** branch-protection
settings to configure by hand in GitHub.

> EASY GAS is **two separate git repositories** — `server/` and `client/` — each with its own
> `.github/workflows/`. Phase 10F adds/derives no GitHub *settings*; §E lists recommendations to
> apply manually in the GitHub UI.

> **GitHub CI status:** the workflows are **locally validated** (YAML parses via the editor language
> server; step commands, npm scripts, service ports, env-var names, artifact paths and the tokenless
> public checkout were reviewed against a clean Linux runner) but this branch is **unpushed**, so no
> GitHub Actions run exists yet. GitHub CI **cannot be claimed as passed before pushing** —
> _locally validated, awaiting first GitHub run._ The full-stack browser suite itself has been run
> end-to-end locally (see §C and `FRONTEND-E2E-10F.md`).

---

## A. Server CI — `server/.github/workflows/ci.yml` (`server-ci`)

Triggers: `push` + `pull_request`. Least-privilege `permissions: contents: read`. Concurrency
cancellation, per-job timeouts, npm caching via `setup-node`. **No `continue-on-error` on any
gate.**

### Job: `build & test`

Runs against **MySQL 8 + Redis 7 service containers** (with health checks). Isolated
`easygas_test` DB via `TEST_DB_NAME`; a **runtime-generated throwaway `APP_KEY`** (via `openssl`,
never a real secret).

| Step | Command / purpose |
|---|---|
| Install | `npm ci` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| OpenAPI contract check | `npm run openapi:check` — 3.1 structure, unique operationIds, all `$ref`s resolve, committed `docs/openapi.json` up to date, and **route drift** (see §D) |
| Test DB setup | `npm run test:setup` (migrate + seed the isolated `*_test` DB) |
| Migration down/up | rollback then re-migrate, then re-seed — exercises down→up. Most migrations are reversible; a few have an intentional no-op `down()` (e.g. `cancel_pending_recovery_sms`), which the step still runs cleanly |
| Audit smoke | `npm run audit:verify` on a clean chain |
| Full suite | `npm run test:all` (all e2e **incl. audit-integrity + observability**) — **fake-backed**: in-memory RedisLike (see note), fake/console SMS, in-memory or local storage |
| Focused concurrency | `npm run test:audit` + `npm run test:riskpolicy` |
| **Real-Redis integration (required)** | `npm run test:redis-int` — the **actual** `RedisBackend` + Lua rate limiter against the live `redis:7` service (see note) |
| **Prod dependency audit (GATE)** | `npm audit --omit=dev --audit-level=high` — fails on high/critical |
| Full dependency audit | `npm audit` — **report-only**, never gates |

> **Fake-backed vs real-Redis coverage.** Under `NODE_ENV=test`, `getRedis()` returns the
> deterministic **in-memory** `RedisLike` (identical atomic semantics, always ready, no socket) even
> when `REDIS_URL` is set — so the ~27 ordinary suites are fast and hermetic and never depend on a
> live Redis being connected before the first request or leave an open handle. That intentionally
> does **not** exercise the real client, so a dedicated **required** suite,
> `tests/redis-integration.e2e.ts` (`npm run test:redis-int`), runs the **real** ioredis
> `RedisBackend` against the CI `redis:7` service and verifies: explicit connection **readiness before
> the first command** (the cold-start race that otherwise fails closed with a 429), the **real Lua**
> rate limiter (concurrent-increment atomicity, TTL preservation + repair, counters shared across two
> clients), **bounded failure** when Redis is down plus the **fail-closed** login policy, and clean
> teardown (all resources closed in `finally`; the process exits naturally — a leaked handle surfaces
> as a hang, never hidden by a forced exit). **Safety:** it **requires** `REDIS_URL` **and** an
> explicit `REDIS_TEST_DISPOSABLE=1` opt-in (fail-closed; `NODE_ENV=test` alone is not sufficient), it
> never `FLUSHDB`s, and it pins a **unique per-run key prefix** (`itest:<uuid>:`) for the app and all
> its clients so cleanup deletes only that exact prefix — the shared `eg:*`/`eg:rl:*` namespace is
> never touched (a regression test asserts an out-of-prefix rate-limit key survives cleanup).

### Job: `secret scan`

`gitleaks` over the repository.

### Job: `actionlint`

Self-lints the workflow files.

---

## B. Client CI — `client/.github/workflows/ci.yml` (`client-ci`)

### Job: `lint · types · tests · build`

| Step | Command / purpose |
|---|---|
| Install | `npm ci` |
| Lint | `npm run lint` |
| Typecheck | `tsc -b` + `tsconfig.test.json` |
| Tests | `npm test` — unit + component (the isolated frontend tests, **executed**) |
| Build | production build |
| **Bundle-size budget** | `node scripts/bundle-budget.mjs` — main chunk gz **≤175 KB**, total JS gz **≤320 KB** (current ~121 / ~210) |
| **Prod dependency audit (GATE)** | `npm audit --omit=dev --audit-level=high` — prod deps **0** |
| Full dependency audit | `npm audit` — report-only (dev toolchain advisories) |
| Playwright cache + install | Playwright browser cache + `playwright install chromium` |
| Playwright spec discovery | `npm run test:e2e -- --list` (compiles specs, lists tests) |

### Job: `actionlint`

Self-lints the workflow files.

> The client's per-repo gate runs **unit + component** tests and *discovers* (does not execute)
> the Playwright specs — keeping it fast and hermetic. The full browser E2E **executes** in the
> separate `e2e-fullstack` workflow, which is a **blocking check on PRs** — see §C.

---

## C. Cross-repo full-stack browser E2E — `e2e-fullstack` (both repos)

Both GitHub repositories are **PUBLIC** — `zeten-nz/easygas-guide` (client) and
`zeten-nz/easygas-guide-server` (server) — so the cross-repo checkout needs **no credential of any
kind**: no `SERVER_REPO_TOKEN`, no PAT, no deploy key, no org secret. The "other" repo is fetched
with a **tokenless, read-only, shallow HTTPS clone** (`git clone --depth 1 --branch <ref>
https://github.com/…`), and the `actions/checkout` of the current repo uses
`persist-credentials: false` so nothing is left on disk.

Each repo carries a **symmetric mirror** of the same workflow:

| Workflow | Tests |
|---|---|
| `client/.github/workflows/e2e-fullstack.yml` | **client PR branch × server `main`** |
| `server/.github/workflows/e2e-fullstack.yml` | **server PR branch × client `main`** |

- **Triggers:** `pull_request` (a **blocking check** on relevant PRs), `push` to `main`, and
  `workflow_dispatch` (optional `client_ref` / `server_ref` inputs for coordinated PR testing).
- **No `repository_dispatch`** is used in either direction, so there is **no cross-repo trigger
  loop**. `concurrency` cancels superseded runs.
- Least-privilege `permissions: contents: read`; actions pinned to release tags; per-job timeout.
- Spins up **MySQL 8 + Redis 7** service containers, builds the server, installs Playwright
  Chromium, then runs `npm run test:e2e` — the client's Playwright `webServer` starts the
  `../server` harness (isolated `easygas_test` DB, fake SMS, in-memory storage, **ACTIVE** test risk
  matrix, seeded published template + per-(flow × project) DRAFT jobs) and Vite together.
- **Executes the complete browser safety journeys** (`e2e/workflow.spec.ts`): happy path, blocking
  risk, reopen, assignment, and GPS states — on **desktop Chrome + Pixel 5** — plus the
  visual/responsive spec. Every status transition is driven through the real UI/API.

### The workflow fails loudly (never a silent green)

- **Zero specs discovered** → fails (`--list` count guard).
- **Any spec skipped, or zero specs executed** → fails (`scripts/assert-e2e-complete.mjs` reads the
  Playwright JSON report after the run with `if: always()`; reopen now runs on **both** profiles, so
  there are no sanctioned skips to whitelist).
- **Backend not ready** → the Playwright `webServer` health gate on `/api/v1/health` must pass
  before specs run; **migrations that fail** or an **inactive risk policy** abort the harness at
  boot, so the run fails.
- **Unexpected severe browser console errors / unexpected failed API requests** during a clean
  journey → fail the run (`guardPage` on the happy path; the visual spec guards the primary routes).

> Backend HTTP e2e (`server/tests/*.e2e.ts`) and the client component tests are **not** counted as
> browser E2E — only `workflow.spec.ts` / `visual.spec.ts` run in a real browser here.

---

## D. OpenAPI contract check (context)

`npm run openapi:check` is a **server CI gate**. OpenAPI 3.1 is the single source of truth
(`src/openapi/spec.ts`, 88 operations / 72 paths / 18 tags) generated to `docs/openapi.json` via
`npm run openapi:gen`. The check validates structure, unique operationIds, `$ref` resolution, that
the committed `docs/openapi.json` matches the source, and **route drift** — every implemented
Express route is documented and vice versa. The internal `/metrics` endpoint is **intentionally
excluded** from the contract.

---

## E. Branch Protection (recommended — configure manually in GitHub)

> **These are RECOMMENDATIONS.** Phase 10F does **not** change any GitHub settings; apply the
> following in each repository's **Settings → Branches → Branch protection rules** (and
> **Settings → Environments**) by hand.

### Required status checks

**Server repo** — require:

- `server-ci / build & test`
- `server-ci / secret scan`
- `server-ci / actionlint`

- `e2e-fullstack / browser E2E (server PR × client main)` — **add after its first successful run**

**Client repo** — require:

- `client-ci / lint · types · tests · build`
- `client-ci / actionlint`
- `e2e-fullstack / browser E2E (client PR × server main)` — **add after its first successful run**

> The cross-repo `e2e-fullstack` workflow **is** intended as a required check now that both repos
> are public and the checkout needs no credential (see §C). GitHub only offers a check as
> "required" once it has reported at least once, so **add it to branch protection after its first
> successful GitHub Actions run** (a name cannot be pre-required before it has ever executed).

### Recommended rule settings (both repos, `main`)

| Setting | Recommendation |
|---|---|
| Pull request required | **Yes** — no direct push to `main` |
| Required approvals | ≥ 1 |
| Dismiss stale approvals | **On** (new commits invalidate old approvals) |
| Required conversation resolution | **On** |
| Required status checks (above) | **On**, "require branches up to date" |
| Force-push | **Blocked** |
| Branch deletion | **Blocked** (no unreviewed branch-deletion bypass) |
| Include administrators | Recommended (no bypass) |

### Protected deployment environment

Configure a protected **deployment environment** (e.g. `production`) with its **own separate
approval** (required reviewers) so deploys are gated independently of merges to `main`.

---

## F. Action-pinning posture

**Official GitHub actions are pinned to a verified commit SHA** (with a `# vX.Y.Z` comment recording
the tag), so a re-pointed tag cannot silently change what runs, and no deprecated action runtime
remains. The first GitHub run rejected `actions/cache@v4.1.2` as deprecated; the fix updated every
official action to its latest release, SHA-pinned:

| Action | Tag | Pinned commit |
|---|---|---|
| `actions/checkout` | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | `v7.0.0` | `820762786026740c76f36085b0efc47a31fe5020` |
| `actions/cache` | `v6.1.0` | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` |
| `actions/upload-artifact` | `v7.0.1` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |

Each tag was confirmed as the current latest release on the action's official GitHub releases page,
and each SHA resolved with `git ls-remote`. **Third-party** actions (`gitleaks/gitleaks-action@v2`,
`raven-actions/actionlint@v2`) are deliberately **left at their reviewed major tag** — they are not
version-bumped blind.

## G. Full-stack E2E robustness (first-run hardening)

- **Logs the exact refs/SHAs** it is testing at the start of the job (client SHA + server SHA), so a
  coordinated run's inputs are unambiguous. Refs default to `main` and are overridable via
  `workflow_dispatch` — no stale commit is ever hard-coded.
- **Fixture preflight** — the harness exposes an unauthenticated, non-sensitive
  `GET /api/v1/e2e/preflight` (booleans/counts + short plate codes only), and the client's Playwright
  `global-setup` calls it **before opening any browser**. If the wrong/old server was cloned (e.g. a
  pre-10F `main` with no preflight route → 404), the run fails fast with a clear message instead of 12
  opaque "job not found" failures. The harness also self-checks fixtures at boot and refuses to start
  if they are incomplete.
- **Accurate result gate** — `scripts/assert-e2e-complete.mjs` reads the Playwright JSON report and
  reports discovered / executed / passed / failed / flaky / skipped / interrupted / global-errors,
  failing with the *real* reason (e.g. "12 spec(s) failed", not a misleading "zero executed"). It has
  its own unit-test suite (`npm run test:ci-assert`).
- **Failure artifacts** — on `failure() || cancelled()` it uploads the HTML report, `test-results/`
  (traces/screenshots/error-context), the JSON report, and a **redacted** harness log (SMS/OTP lines
  dropped; phones/coordinates scrubbed — never DB dumps, cookies, tokens, OTPs, GPS or signatures).
  `if-no-files-found: warn` so a missing report never masks the original test failure.
