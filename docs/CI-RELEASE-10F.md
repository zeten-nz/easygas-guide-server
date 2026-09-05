# CI & Release Automation — Phase 10F

Continuous-integration workflows for both repositories, the cross-repo full-stack E2E strategy
(and why it is separate), the action-pinning posture, and the **recommended** branch-protection
settings to configure by hand in GitHub.

> EASY GAS is **two separate git repositories** — `server/` and `client/` — each with its own
> `.github/workflows/`. Phase 10F adds/derives no GitHub *settings*; §E lists recommendations to
> apply manually in the GitHub UI.

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
| Migration down/up | rollback then re-migrate to verify reversibility, then re-seed |
| Audit smoke | `npm run audit:verify` on a clean chain |
| Full suite | `npm run test:all` (all e2e **incl. audit-integrity + observability**) |
| Focused concurrency | `npm run test:audit` + `npm run test:riskpolicy` |
| **Prod dependency audit (GATE)** | `npm audit --omit=dev --audit-level=high` — fails on high/critical |
| Full dependency audit | `npm audit` — **report-only**, never gates |

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

> The client's blocking gate runs **unit + component** tests and *discovers* (does not execute)
> the Playwright specs. Full browser E2E is a **separate** workflow — see §C.

---

## C. Cross-repo full-stack E2E — `client/.github/workflows/e2e-fullstack.yml`

- **Not part of the blocking gate.** Triggers: `workflow_dispatch` + a **weekly schedule**.
- Checks out **client + server**, spins up MySQL + Redis, builds the server, installs Chromium, and
  runs `npm run test:e2e` — the client's Playwright `webServer` starts the `../server` harness and
  Vite together for a real full-stack browser run.
- The server checkout needs repo variable **`SERVER_REPO`** + a **read-only** secret
  **`SERVER_REPO_TOKEN`** (or public repos).
- **Fails loudly if `SERVER_REPO` is not configured** — it is never silently skipped.

### Why cross-repo E2E must be separate

The default `GITHUB_TOKEN` **cannot check out a *different* private repository**. So a full-stack
browser E2E that needs both repos **cannot** be a blocking check on the client gate without an
explicitly configured, read-only cross-repo credential. Rather than weaken the client gate (or bake
in a broad token), full-stack E2E is isolated to an opt-in / scheduled workflow that fails visibly
when its cross-repo credential is missing. The per-repo CI gates stay fast, hermetic, and
self-contained.

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

**Client repo** — require:

- `client-ci / lint · types · tests · build`
- `client-ci / actionlint`

> The cross-repo `e2e-fullstack` workflow is **not** a required check (it cannot be — see §C).

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

Action versions are pinned to **stable release tags** — `actions/checkout@v4.2.2`,
`actions/setup-node@v4.1.0`.

> **Supply-chain hardening note:** for in-org use, pin actions to **commit SHAs** rather than tags,
> so a re-pointed tag cannot silently change what runs in CI.
