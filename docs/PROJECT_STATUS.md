# EASY GAS — PROJECT STATUS (canonical)

> This is the **canonical, git-tracked** project status. The copy at the repo-root
> (`../../PROJECT_STATUS.md`, outside both git repos) is now **non-authoritative**.

**Current phase:** Phase 11C — Evidence Review UX & Understandable Risk Policy — **implemented + tested
locally** on branch `phase/11C-evidence-risk-ux` in both repos (server from `origin/main` `4df8c91`,
client from `origin/main` `de0dc1f`, both post-11B-merge). Full detail: `PHASE-11C.md` (+ client
`docs/PHASE-11C.md`). **Not pushed / not merged / not deployed.** Phase 11B merged (server main `4df8c91`,
client main `de0dc1f`). Prior phases retained below as reference.

## Phase 11C — Evidence Review UX & Understandable Risk Policy

Read-only, additive; **no migration** (the existing model sufficed), no safety thresholds/approval
authority/business rules changed, no policy activated on developer/production, no production data touched.

- **Completed-job evidence** — new `GET /jobs/:id/photos` (jobs.view, branch-scoped 404): a truthful,
  cross-step/cross-cycle listing where each photo's **cycle is derived only from the immutable
  completion snapshot** (never from today's `jobs.cycle`), only `READY` is real/downloadable, the
  uploader is the actual performer, and a server-computed `role`
  (COMPLETED_CYCLE / CURRENT / SUPERSEDED_ATTEMPT / PENDING / UNVERIFIED / FAILED) labels provenance.
  Downloads reuse the existing READY-only step file endpoint (no bypass; no signed URLs anywhere).
  `GET /jobs` gained additive `technicianId`/`dateFrom`/`dateTo` filters.
- **Risk policy** — new read-only `GET /risk-policy/versions/:version` (definition + server-computed
  classified grid + approver/provenance + blocked operations) and
  `GET /risk-policy/versions/:version/preview` (illustrative classification via the SHARED evaluator;
  creates nothing, works for DRAFT/ACTIVE/RETIRED, and is **distinct from production `assessRisk`**,
  which still fails closed without an ACTIVE policy). `listMatrices` now returns `approvedByName`/
  `supersededBy`. Provisional (definition provenance) is kept distinct from lifecycle approval.
- **Client** — completed-job filters (status/branch/date + a bounded searchable **responsible-technician**
  combobox, URL-synced) + a "Fotolar" gallery embedded in JobDetail (grouped by cycle/step, lazy
  thumbnails, honest role labels incl. multi-cycle + HISTORICAL_UNCLASSIFIED) + an accessible full-screen
  photo viewer (top-bar/side controls, no bottom-anchored footer; keyboard/focus/zoom/retry), and a
  redesigned `/app/admin/risk-policy` (plain-language explainer, real server matrix, illustrative preview,
  history + compare, activation/retirement flow using the centered Modal).
- **Provenance (verified):** photo cycle is derived only from the immutable snapshot; a photo can span
  MULTIPLE snapshots (`cycles[]`); "Joriy" is reliable current-attempt evidence; insufficient provenance is
  HISTORICAL_UNCLASSIFIED (never "current"); the uploader (`created_by`) is kept distinct from the step
  performer (`completed_by`) and never guess-attributed. `GET /jobs/technicians` is historical filtering
  access, not assignment eligibility.
- **Acceptance review:** patched the two prod npm-audit advisories (morgan 1.11→1.12, multer 2.2→2.3 —
  compatible minor bumps, no `--force`); **prod & full audit now 0** (client prod 0 / full 5 dev-only,
  unchanged); upload workflows re-verified on multer 2.3.0.
- **Verification (local, isolated `*_test`):** server `test:job-evidence` **11/11** + `test:riskpolicy-preview`
  **7/7**, full `test:all` green, typecheck/build/`openapi:check` clean (**123 ops / 94 paths, no drift**).
  Client **77 component tests**, lint + `tsc -b` + build clean, bundle budget OK; browser E2E
  `evidence-policy.spec` (9 tests) on chromium + Pixel-5. The Playwright harness seeds `E2E-EVI-<proj>`
  (completed) + `E2E-EVR-<proj>` (reopened) evidence jobs via the real workflow.
- **Cross-repo:** client needs the new server endpoints → **merge server first, then client**.

---

## Phase 11B — Product & Service Catalogue + Reference Data — MERGED

Phase 11B was **merged** (server `main` = `4df8c91`, client `main` = `de0dc1f`; PRs #9/#10). Original
implementation notes retained below.

**Repos:** two separate git repositories — `server/` and `client/`. Project-root files (like the old
`PROJECT_STATUS.md`) live **outside** both repos.

---

## Phase 11B — Product & Service Catalogue + Reference Data

Employee-only price base + reference-data management. Full details: `PHASE-11B.md`.

- **Model (migration `20260908000003`):** `products` (code unique **per company**, brand≠company,
  category, unit?, exact fixed-point `price_minor` minor units — **null=unknown, 0=free** — `version`
  optimistic-concurrency, provenance), `services` (global code, duration in minutes, **explicit
  `price_basis` NET/GROSS/UNKNOWN + optional tax bp — the prototype's 12% VAT is NOT assumed**),
  reference tables (`catalog_companies`/`catalog_brands`/`product_categories`/`service_categories`/
  `catalog_units`/`injection_reference`), polymorphic `catalog_price_history`. FKs RESTRICT throughout;
  service centres reuse `branches`. Migration up→down→up verified on `easygas_test`.
- **Injection** modelled cleanly (greenfield — no prior field): `technology` (port/multipoint vs direct)
  is independent of `forced_induction` (Turbo is a separate attribute, never a technology); `designation`
  is the manufacturer label; UNKNOWN supported; no legacy remap.
- **Concurrency:** `version` optimistic-concurrency (`409 STALE_WRITE`); price change + history row +
  audit are one atomic transaction; newly-assigned references are locked `FOR UPDATE` so a concurrent
  reference delete never races a create into a raw FK error (→ clean `REFERENCE_IN_USE` / `INVALID_*`).
- **Reference rules:** normalized (whitespace/case) duplicate detection, **no fuzzy merge**; archive
  always; delete only when unused (`409 REFERENCE_IN_USE`), re-checked transactionally; FKs untouched.
- **API/authz:** `catalog.view` = ADMIN/RAHBAR/SIFAT (read), `catalog.manage` = **ADMIN only**. Bounded
  pagination 25/50, deterministic sort + id tie-breaker, filtered totals, allowlisted sort, indexed.
  OpenAPI regenerated — **119 ops / 90 paths, no drift**.
- **Client:** routes `/app/catalog/products|services(/:id)` (Narx bazasi, tabs) + `/app/reference`
  (Ma'lumotnomalar), reusing the 11A shell/Pagination/DropdownMenu; URL table state, price-history,
  archive/reactivate/delete, stale-edit + in-use conflict messages, mobile layouts.
- **Import** (`npm run catalog:import`): parses source as DATA (no eval), **dry-run default**,
  insert-only + idempotent (preserves manual edits), provenance, one transaction; **`--apply` guarded to
  `*_test` only**. The **real owner prototype** was provided and **verified on `easygas_test`**: dry-run +
  apply reproduce the expected counts — **products 219 (EASY GAS 158, EAST ENERGE 61), services 63**,
  companies 2 / brands 13 / product-categories 22 (REDUKTOR/Reduktor case-merged) / service-categories 10,
  0 missing/duplicate/rejected; exact money (product `price` = VAT-inclusive, service `base` = NET + 12%
  tax metadata); idempotent re-import; manual edits preserved; atomic rollback on failure. **Production
  import NOT performed** (test DB only) — imported prices are provisional.
- **Reference selectors** are bounded server-backed searchable comboboxes (`RefCombobox`, `useInfiniteQuery`,
  20/page, debounced, load-more, select-by-id for archived/off-page values) — no first-page-of-100 truncation.
- **Verification (local, isolated `*_test`):** server `test:catalog` 21/21 + `test:all` **30/417/0**,
  typecheck/build/openapi clean, prod+full audit **0**; client `npm test` (component + money unit),
  lint/tsc/build clean, prod audit **0** / full **5** (dev-only); browser E2E `catalog.spec` on
  chromium + Pixel-5.

**Out of scope / not begun:** inventory, stock, orders, payments, invoices, procurement, job billing,
photo-gallery/risk-policy redesign, Telegram/SMS, 5 WHY, offline, deployment. **Phase 11C not started.**

---

## Phase 11A — Admin Workspace, Employee Profiles, Pagination & Safe Template Deletion

Full detail: `PHASE-11A.md`. Base SHAs: server `origin/main` = `fe493f9`, client `origin/main` =
`c7b1997`.

### Employee directory (§B) — IMPLEMENTED + TESTED
- `GET /users` excludes the current viewer from their own directory **only when `excludeSelf=true`**
  (opt-in; the employee directory passes it, verified as the endpoint's sole consumer — the assignment
  picker uses a different endpoint). Off by default, so `GET /users` stays a general lookup that
  includes everyone for any other/future consumer. When on, the `whereNot(id, actor.id)` is applied to
  the SHARED builder so the caller is removed BEFORE COUNT and pagination — the total/pages never
  include the caller; only the caller is hidden, every other user (**including other administrators**)
  remains.
- Deterministic order with an **id tie-breaker** (`created_at desc, id desc`) so equal timestamps never
  reshuffle across pages. Bounded limit unchanged (Zod `min 1, max 100, default 25`; the UI offers 25/50).
- Client: a shared `Pagination` (persistent summary "Jami N xodim · a–b ko'rsatilmoqda", page-size 25/50,
  prev/next), URL-synced page/size/filters (`useTableParams` → first `useSearchParams` usage) so the view
  survives reload and browser Back/Forward, page resets on filter/size change, and an empty current page
  recovers to the last valid page. A compact table (desktop) / cards (mobile); the name links to the
  profile, row actions live in an accessible menu (no full-row click). The same pagination is used on Jobs.

### Own & employee profiles (§C) — IMPLEMENTED + TESTED
- New self-scoped `GET /users/me` (auth only, **no `users.view`**) returns the caller's own `UserDetail`;
  it never accepts a target id. Client `/app/profile` ("Mening profilim", opened from the account menu):
  read-only identity (truthful no-branch state), and a clear path to the **existing** change-password
  workflow — `/change-password` now serves both the forced first-login change and a voluntary change
  (same server endpoint; all-session revocation + fresh session/CSRF preserved). Identity fields are not
  self-editable and no new self-edit permission/password API was added.
- Employee profile `GET /users/:id` (existing) exposed at client `/app/admin/users/:id` — authorization is
  **server-enforced**: out-of-scope / nonexistent ids → **404 (never 403)**; roles without `users.view` →
  403; the forced-change gate blocks these endpoints. Management actions (edit / block-unblock / one-time
  temporary-password reset) reuse the existing secure modals. Loading / error / not-found / forbidden
  states are all handled.

### Safe template deletion (§D) — IMPLEMENTED + TESTED
- New `DELETE /checklist-templates/:id` (`templates.manage`) permanently deletes a template **only** when
  every version is still DRAFT (never published → never assigned) and no job references it. Eligibility is
  re-checked **inside a transaction** under a **consistent lock order — template row → version rows → audit
  last — now shared by ALL template mutations** (`createVersion`, `publishVersion`, `archiveVersion`,
  `deleteTemplate`; publish/archive gained the leading template-row lock in this review to remove a
  possible version-lock-ordering deadlock). So concurrent template mutations serialize on the template row:
  a publish that lands first is seen as history and the delete is refused; one that blocks then 404s on the
  deleted version. `delete-vs-createVersion` and `delete-vs-assignment` are **mutually-exclusive states**
  (delete needs all-DRAFT; createVersion needs no-DRAFT; assignment needs a PUBLISHED version), so they are
  not valid concurrent pairings — the valid ones (`delete-vs-publish`, `delete-vs-draft-mutation`) are
  covered by ×5 concurrent regressions asserting no orphan rows, no 500/raw SQL, and a clean win/conflict. A published/archived template → **409 `TEMPLATE_HAS_HISTORY`** (archive instead); a
  referenced one → **409 `TEMPLATE_IN_USE`** (defensive; the RESTRICT FKs are the last-line backstop, never
  weakened). Children are deleted child→parent (steps [measurements cascade] → versions → template). A
  `TEMPLATE_DELETED` audit records the name + version count only (no step internals). `listTemplates`/
  `getTemplate` now return an advisory `deletable` + `deletableReason`. The existing version publish/archive
  lifecycle is unchanged (no whole-template archive state added). Client: status labels
  **Qoralama / Faol / Arxivlangan**, a status filter, per-template delete with a confirmation naming the
  template + a permanent-vs-archive explanation, a shown reason when deletion is unavailable, and an honest
  refetch on success **or** conflict (never an optimistic success).

### Shell redesign (§A) — IMPLEMENTED
- The horizontal-scroll top nav is replaced by a **grouped left sidebar** (Ish / Xodimlar / Amaliyot /
  Xavfsizlik) + a compact top bar (page context + account menu) + an accessible **mobile drawer**
  (Escape/backdrop close, ≥44px targets). Brand **blue** is the primary action colour, brand **red** is
  reserved for destructive (the global `Button` `primary` moved to blue + a solid `danger` variant added —
  a consolidation, not a parallel system). The admin home is concise task-oriented cards (no hero, no
  invented analytics). Existing route URLs are unchanged and every page renders inside the new shell.

### Verification (LOCAL only — no GitHub Actions run for this branch)
- **Server:** new `test:admin-workspace` (15 cases — directory exclusion **opt-in** (default keeps the
  caller) / pagination determinism / bounded limits / filters, own-profile without `users.view`, profile
  authz 404-vs-403 + forced-change gate, template delete success/authz/history-block, ×5 concurrent
  delete-vs-publish and delete-vs-draft-mutation races, audit redaction). Full `test:all` green (all suites)
  — see the checkpoint. Typecheck + build + OpenAPI check clean; OpenAPI regenerated (89 ops / 72 paths).
  No migration required (behavioural change only; no schema change). Prod audit **0**, full audit **0**.
- **Client:** 61 unit/component tests (17 new — Pagination, Sidebar authorization, ProfilePage states,
  DeleteTemplateDialog conflict feedback, directory link/pagination, DropdownMenu keyboard/focus). Lint +
  `tsc -b` + `tsc -p tsconfig.test.json` + production build clean. Prod audit **0**, full audit **5**
  (dev-only — vite/vitest/vite-node/esbuild toolchain; no production dependency affected; fix is a breaking
  major bump). The **full browser E2E suite** now runs on **BOTH configured projects** (chromium *and* the
  Pixel-5 mobile project) on system Edge (`PW_CHANNEL=msedge`): `admin-workspace` (directory pagination with
  55 synthetic employees + a second admin, profile + Back, own-profile → change-password, create+delete a
  draft template, published-template-cannot-delete, mobile drawer with **Escape-close + focus restore** and
  no overflow at 360/768/1366/1920), the pre-existing `manual-recovery` safety journey (updated for the new
  shell — "Xodimlar" heading + reset via the accessible row menu, and isolated onto its own branch so it
  never perturbs the directory count), `visual` smoke, and the 5 `workflow` safety journeys —
  **24 tests / 24 passed / 0 failed / 0 skipped** (see the checkpoint).
- **Out of scope (documented as later phases):** price/service catalogue, reference-data CRUD, injection
  modelling, risk-matrix redesign, photo-gallery workflows, Telegram/SMS, inventory/payments/notifications/
  offline/5-WHY.

### Cross-repo compatibility & merge order
Contracts: **added** `GET /users/me` + `DELETE /checklist-templates/:id`; `GET /users` now excludes the
caller; `ChecklistTemplate` gained additive `deletable`/`deletableReason`. The client needs the new server
endpoints, so **merge the server PR first**, then the client PR (its `e2e-fullstack` gate goes green against
the updated server `main`). To validate before merging, dispatch the client `e2e-fullstack` with
`server_ref=phase/11A-admin-workspace` (and the server mirror with `client_ref=phase/11A-admin-workspace`)
— both must be green first. Do not merge the client PR against a server `main` lacking the endpoints.

---

## Manual employee password recovery — IMPLEMENTED + TESTED

Product decision: the Guide is for EASY GAS employees only. Password recovery is now **manual**:
an employee contacts an admin via Telegram (**@EasygasGarantbot** — a support-request channel, NOT
an automated auth/OTP provider); the admin verifies them **out of band**, then issues a one-time
temporary password from the admin UI. There is **no** automatic Telegram OTP, account linking, or
self-service reset.

**Server (`phase/manual-employee-recovery`):**
- Admin reset endpoint `POST /users/:id/reset-password` — ADMIN-only permission `users.reset_password`;
  requires the admin's **own** password (recent-auth) + a mandatory reason; CSRF + a fail-closed
  per-admin rate limit; generates a cryptographically-random temporary password (returned **once**,
  `Cache-Control: no-store`); atomically sets it (bcrypt), sets `must_change_password` + a configurable
  expiry (`TEMP_PASSWORD_TTL_MINUTES`), **revokes all** the target's sessions and invalidates prior
  recovery credentials. Self-reset is refused (no last-admin backdoor). Blocked/inactive users stay
  blocked. The audit chain records actor/target/reason/timestamp and **never** the password or its hash.
- First-login change `POST /auth/change-password` — authenticated; verifies current (temporary)
  password, rejects reuse, re-checks temp expiry on the authoritative path, rotates the session + CSRF.
- Server-side first-login **gate** in `requireAuth`: a temporary-password session may reach only
  `/auth/me` + `/auth/change-password` (+ logout); every business API is refused with
  `PASSWORD_CHANGE_REQUIRED` until the password is changed (optional-auth routes degrade it to anon).
- SMS is now **opt-in** (`smsFeatureEnabled()` = `SMS_PROVIDER==='eskiz'`): startup, readiness and the
  release gate demand a working SMS provider **only when SMS is enabled** — never faking a broken
  provider as healthy. Production requires **no** Eskiz credentials by default. The OTP HTTP endpoints
  are removed; the durable outbox/worker infra is **retained** (unchanged), and a migration
  (`20260908000002_cancel_pending_recovery_sms`) safely CANCELS any queued recovery SMS (history
  preserved; tables not dropped).
- Migrations: `20260908000001_manual_recovery_password_fields` (adds `must_change_password`,
  `temp_password_expires_at`; idempotent, reversible) + the cancel migration above. Applied only on an
  isolated `*_test` DB; migrate + rollback + re-migrate run **locally** (the CI workflow is wired to run
  the same down/up step, but has **not** been executed on GitHub Actions for this branch — see
  "Verification provenance"). The cancel migration documents the operator deploy sequence
  (stop/drain the dedicated SMS worker BEFORE running it; a DB migration cannot retract a send already
  handed to the provider).
- Tests: new `test:manual-recovery` suite (20 cases — authz, admin re-auth, one-time secret + no-store,
  session revocation, forced-change gate on direct business APIs, expiry + repeated/concurrent resets,
  **concurrent reset-vs-change race**, blocked-stays-blocked, CSRF, rate limits, audit redaction,
  removed-endpoints-404, manual-recovery config/readiness). `auth`/`hardening`/`sms-outbox`/`runtime`
  suites updated for the removal. **Full `test:all` green (28 suites) — executed LOCALLY**; typecheck +
  build + OpenAPI check clean locally.

### Verification provenance (what was actually run, and where)
- **Local machine only.** Every green result above (server `test:all` 28 suites, the browser E2E, client
  lint/tsc/component tests) was **executed locally**. **No GitHub Actions run has occurred** for these
  branches — nothing is pushed, so `server-ci` / `e2e-fullstack` have **not** validated this code. The CI
  is *wired* to run these checks; that wiring is not the same as a green run.
- **Browser E2E:** chromium project executed and passed (system Edge). The `mobile` (Pixel 5) project is
  authored + discovered but was **not** run locally; CI would run both.
- **Concurrency race** (reset-vs-change) is covered by a focused server test; the change-password path now
  locks the user row `FOR UPDATE` and re-verifies inside the transaction (see below).

**Client (`phase/manual-employee-recovery`):**
- "Parolni unutdingizmi?" now opens a **support page** (no OTP wizard): Uzbek instructions to contact
  the admin via Telegram with name/branch/work-phone, an explicit "never send your current password"
  warning, and a **Telegram orqali murojaat** button → `https://t.me/EasygasGarantbot`.
- Forced first-login **"Yangi parol o'rnating"** screen + route guard (temp-password sessions are held
  there until they change the password); admin **"Vaqtinchalik parol"** action in the Users page
  (confirm admin password + reason → temporary password shown once, copy-to-clipboard, never persisted).
- Lint + `tsc -b` clean.

**Browser E2E — MANUALLY-VERIFIED:** new `e2e/manual-recovery.spec.ts` (admin UI reset → employee temp
login → forced change → normal access → new-password login) **executed and passed** on system Edge
(`PW_CHANNEL=msedge`, chromium project, against the full-stack harness).

### Remaining production blockers (unchanged ownership)
- **ACTIVE, approved risk matrix** — still DRAFT; approval belongs to an **authorized EASY GAS safety
  specialist**, not this work. Enforced by the release gate (fail-closed). **PRODUCTION-BLOCKED.**
- **Attested release inputs** (CI green, restore drill, full-stack safety Playwright on GitHub Actions,
  backups, secrets, monitoring, manual smoke) — per `RELEASE-CHECKLIST-10F.md`.
- SMS is **no longer a blocker** by default: the `sms_provider_functional` gate now applies only when
  SMS is explicitly enabled (`SMS_PROVIDER=eskiz`).
- Not pushed/merged/deployed; no production data touched; no real Telegram/SMS sent.

### Operational dependency — support-request routing (NOT wired here)
The recovery UX depends on an admin actually **receiving** an employee's request. This change provides
only the outbound **support link** (`https://t.me/EasygasGarantbot`); the link alone does **not** prove
requests reach an admin. The Telegram bot **@EasygasGarantbot** has **no code, repo, or webhook in either
repository** — routing employee messages to admins (an inbox/notification the admin monitors) is a
separate operational integration, owned outside this change. The live bot was **not** inspected or
modified. Until that inbox is wired and verified, treat "employee can request a reset" as **unproven at
the operational level**, even though the website + admin reset flow are complete.

### Cross-repo compatibility (both repos changed; contracts diverge)
Changed contracts: **removed** `POST /auth/{forgot-password,verify-otp,reset-password}`; **added**
`POST /auth/change-password` + `POST /users/:id/reset-password`; login/`/auth/me` user gained an
additive `mustChangePassword` field. Compatibility of the two branches against the *other repo's* current
`main` (verified by inspecting the specs + the changed endpoints, not executed cross-version):
- **server branch × client main** — normal login/app **works** (the extra `mustChangePassword` field is
  ignored by the old client); the old client's OTP recovery screen would **404** (endpoints removed) but
  no browser spec exercises it, so the *server* mirror e2e (server branch × client main) stays green.
- **client branch × server main** — normal login/app **works**; the new admin "Vaqtinchalik parol" action
  and the change-password screen **404** (server main lacks the endpoints); the forced-change flow never
  triggers (server main never sends `mustChangePassword`). The new `manual-recovery.spec` would be **RED**
  against server main.
- **both branches together** — **green** (verified locally, chromium).

**Proposed coordinated validation/merge sequence (no weakened checks, never merge a red PR):**
1. Dispatch the client `e2e-fullstack` with `server_ref=phase/manual-employee-recovery` (the workflow
   accepts a `server_ref` input) and the server mirror e2e with `client_ref=phase/manual-employee-recovery`
   → both must be green **before** any merge.
2. Merge the **server** PR first — its default gate (server branch × client `main`) is green and it is
   backward-compatible for normal operation.
3. After server `main` carries the endpoints, the client PR's default gate (client branch × server `main`)
   turns green → merge the **client** PR, then deploy both together. Do **not** merge the client PR while
   server `main` lacks the endpoints (its e2e is expected red — do not disable the spec to force it green).

---

## Status legend

- **IMPLEMENTED** — built and in the codebase.
- **TESTED** — covered by an automated suite that was executed and passed.
- **MANUALLY-VERIFIED** — confirmed by hand (e.g. browser E2E on a system browser).
- **PRODUCTION-BLOCKED** — cannot go to production until resolved; enforced by the release gate.
- **DEFERRED** — deliberately not done now; documented.

---

## Phase 10F — Integrity, Observability & Release Readiness

Full detail: `PHASE-10F.md` and the topic docs listed at the bottom.

### Audit integrity — IMPLEMENTED + TESTED
- Tamper-evident **per-UTC-day hash chain** over `audit_logs` (`chain_id`, `chain_seq`, `prev_hash`,
  `entry_hash`); `audit_chain_heads` lock table serializes same-day appends (deadlock-free, audit is
  the last lock); deterministic canonical `entry_hash` covering **every semantically-meaningful
  field including `created_at`** (hash schema **v2**; one canonical `UTC_TIMESTAMP(6)` used for both
  the persisted timestamp and the hash). Migration `20260907000002_audit_log_integrity` (reversible;
  v2 corrected in place — unpushed, migrations never left an isolated `*_test` DB).
- Append-only `BEFORE UPDATE` trigger (`audit_logs_no_update`); deletion is **detected** via a
  `chain_seq` gap (blocked in prod via restricted GRANTs, not at DB level in tests).
- **Legacy honesty:** pre-migration rows are NOT retro-chained (`chain_id` NULL); boundary recorded
  in `audit_chain_checkpoints`. No historical-integrity claim for them.
- Verifier `npm run audit:verify` (read-only, `--json`, `--checkpoint`); exit 0/2/1.
- **DOCUMENTED LIMITATION:** a fully privileged DBA can forge a self-consistent chain — the only
  defense is **off-server anchoring** of checkpoints.
- **TESTED:** `npm run test:audit` — 6/6 (chaining, concurrency 15→15 no dup seq, append-only block,
  verify clean, content tamper, deletion gap).

### Observability — IMPLEMENTED + TESTED
- Dependency-free Prometheus metrics; token-gated `GET /api/v1/metrics` (404 unless
  `METRICS_ENABLED=true` + correct bearer, timing-safe; **off by default**; prod config requires a
  token). Low-cardinality labels only (route templates, method, status_class, …; never id/phone).
- `x-request-id` correlation (safe-pattern inbound or fresh UUID); expanded log redaction (phone,
  signature, lat/long/gps/coordinates, `S3_ACCESS_KEY_ID`, `METRICS_TOKEN`).
- **TESTED:** `npm run test:observability` — 5/5 (redaction, 404/404/200 gating, low-cardinality).
- **DEFERRED:** external error tracker (Sentry) + OpenTelemetry tracing (request-id is the seam).

### Timestamp precision — IMPLEMENTED
- Migration `20260907000001_event_timestamp_precision` (reversible, down/up verified): ordering
  columns upgraded 1-second `TIMESTAMP` → `DATETIME(6)`. Defense-in-depth only; the monotonic numeric
  id (+ attempt/sort_order) remains the authoritative tie-breaker.

### OpenAPI contract — IMPLEMENTED + TESTED (CI gate)
- OpenAPI 3.1 single source of truth (`src/openapi/spec.ts`, 88 operations / 72 paths / 18 tags) →
  `docs/openapi.json` (`npm run openapi:gen`). `npm run openapi:check` validates structure, unique
  operationIds, `$ref` resolution, committed-file freshness, and **route drift** (`/metrics`
  excluded). Documents cookie auth, CSRF model + rotation headers, error envelope, pagination, RBAC,
  readiness/liveness.

### CI — IMPLEMENTED
- `server-ci`: build & test (MySQL 8 + Redis 7 services, throwaway APP_KEY, typecheck/build,
  `openapi:check`, migration down/up, audit smoke, full `test:all`, focused concurrency, prod
  `npm audit` GATE) + secret scan (gitleaks) + actionlint; least-privilege, concurrency cancel,
  timeouts, actions pinned to release tags (note: pin to SHAs in-org).
- `client-ci`: lint · types · tests · build, bundle-size budget (main gz ≤175 KB / total gz ≤320 KB;
  current ~121/~210), prod `npm audit` GATE, Playwright spec discovery + actionlint.
- `e2e-fullstack` (**both PUBLIC repos**, symmetric mirror): cross-repo full-stack **browser** E2E,
  intended as a **blocking PR check**. Both repos are public → the other repo is fetched by a
  **tokenless, read-only, shallow HTTPS clone** (NO `SERVER_REPO_TOKEN`/PAT/deploy-key/org-secret;
  `persist-credentials: false`). Client PR × server main; server PR × client main. Triggers
  `pull_request` + `push main` + `workflow_dispatch` (optional refs); **no `repository_dispatch`
  loop**. Executes the complete browser safety journeys and **fails on** zero specs, **any skip** or
  zero executed (`assert-e2e-complete.mjs` over the Playwright JSON report), not-ready backend,
  failed migrations, inactive risk policy, or severe console/API errors. _Locally validated; awaiting
  first GitHub run._ → `FRONTEND-E2E-10F.md`
- **Branch protection = RECOMMENDATION only** (configure in GitHub manually): see `CI-RELEASE-10F.md`
  §E for required checks (add the `e2e-fullstack` check **after its first successful GitHub run**) and
  PR/force-push/environment rules.

### Release gate — IMPLEMENTED
- `npm run release:gate` (`--json` + human): LIVE blockers (migrations, ACTIVE+approved risk matrix,
  SMS ready, audit chain clean, readiness, prod config) + ATTESTED blockers
  (`release-attestation.json`; template `release-attestation.example.json`). Exit 0=READY, 3=BLOCKED,
  1=error. **No flag bypasses a safety blocker.**

### Operations — IMPLEMENTED (artifacts) + MANUALLY-VERIFIED (procedures documented)
- Docs: `OPERATIONS-RUNBOOK-10F.md`, `INCIDENT-RESPONSE-10F.md`, `KEY-ROTATION-10F.md`,
  `BACKUP-RESTORE-10F.md`.
- Artifacts (reference, not recreated): `deploy/{ecosystem.config.cjs (split easygas-api +
  easygas-sms-worker, kill_timeout 30s > 25s shutdown), nginx.example.conf, .env.production.example,
  crontab.example}`; `scripts/{backup-mysql.sh, backup-evidence.sh, restore-mysql.sh}`;
  `loadtest/{smoke.js, README.md}`.

### KNOWN PRODUCTION BLOCKERS — PRODUCTION-BLOCKED (enforced by the live gate)
1. **Eskiz SMS provider is a fail-closed STUB** (no verified official spec) — OTP delivery not
   functional; production cannot be declared ready.
2. **Risk matrix v1 is DRAFT** until an EasyGas safety specialist approves it.

### Test summary (executed this phase)
- Server `test:all`: **27 suites, 0 failed** (incl. observability 5, audit **11** — per-field tamper
  incl. `created_at`/actor).
- Client: **51 tests** (7 unit + 44 component) — **TESTED**; full-stack **browser** E2E
  (`workflow.spec` happy·blocking·reopen·assignment·GPS × desktop + Pixel 5, + `visual`) — **12 per
  pass, run twice, all green** — **MANUALLY-VERIFIED** on system Edge in dev. GitHub `e2e-fullstack`:
  _locally validated, awaiting first GitHub run._ (The old 8 smoke specs are superseded; they do NOT
  satisfy the complete full-stack requirement.)
- Audits: server prod 0 / full 0; client prod 0 / full 5 (dev-only Vitest/Vite/esbuild — **DEFERRED**,
  fixable only by a Vitest major, never shipped).

---

## Prior phases (carried-forward summary)

All phases below are **IMPLEMENTED + TESTED** unless noted. Full history remains in the repo-root
`PROJECT_STATUS.md` (non-authoritative) and each phase's topic doc.

| Phase | Summary | Notes |
|---|---|---|
| **1** | Authentication: login, remember-me, logout, registration→admin approve/reject, password reset (SMS OTP), DB sessions with revocation, rate limiting, audit logging, Uzbek auth UI | 19 E2E |
| **2** | Centralized RBAC (`permissions.ts` + `requirePermission`), user & branch management (soft status only, FK RESTRICT), admin safety rules | 19 E2E |
| **3** | Customers + vehicles global registry (name+phone; normalized plate/VIN; audited transfer, no duplication) | 18 E2E |
| **4** | Jobs core entity, §12 status set, branch scoping (§11), explicit audited start/cancel, no DELETE/soft-delete | 23 E2E |
| **5** | Checklist templates/versions (DRAFT→PUBLISHED→ARCHIVED, immutable), sequential execution, decimal-safe measurement validation, installation details | 26 E2E |
| **6** | STOP approvals (§17–18): MASTER-only decide, immutable history, row-locked | 17 E2E |
| **7** | §3 correction loop (rework, attempt-scoped), §19 photo evidence + storage abstraction, magic-byte upload security | 20 E2E |
| **8** | §22 completion gate (server re-recalculates all conditions), customer signature artifact, MASTER close | 15 E2E |
| **9** | §24 reopen cycle (SIFAT/ADMIN), selected-step redo, QUALITY_REVIEW → quality confirm, read-only §26 inspection | 15 E2E |
| **10A** | Security hardening: CSRF, trust-proxy, OTP/reset/last-admin/assign/branch races, isolated test DB, error mapping | `SECURITY-PHASE-10A.md` |
| **10B** | Evidence storage lifecycle (PENDING→READY→FAILED, UNVERIFIED legacy), two-transaction upload, S3/MinIO provider, reconciliation, signature cycle binding | `EVIDENCE-STORAGE-10B.md` |
| **10C** | Session lifecycle, Redis abstraction, atomic rate limiting (fail-closed auth), durable encrypted SMS outbox + worker, readiness/liveness, graceful shutdown, prod config validation, cleanup CLI. **Eskiz adapter deferred** (fail-closed stub) | `PRODUCTION-RUNTIME-10C.md` |
| **10D** | Safety domain: server-authoritative risk engine + versioned matrix governance (DRAFT→ACTIVE→RETIRED, one-ACTIVE singleton), §22 critical-completion gate, assignment/responsibility, immutable snapshots (SHA-256), GPS evidence. **Risk matrix v1 DRAFT/provisional** | `SAFETY-DOMAIN-10D.md` |
| **10E** | Frontend integration & branding: real EASY GAS branding, light-first token system, safety widgets wired into routed job-detail, route code-splitting, error boundaries; risk-policy concurrency made race-proof; Playwright reproducible (8/8 on Edge) | `client/docs/FRONTEND-UX-10E.md` |
| **10F** | CI (both repos) + tokenless symmetric cross-repo **full-stack browser E2E** (5 safety journeys × desktop + Pixel 5, run twice); dependency-free token-gated metrics + expanded redaction; OpenAPI 3.1 SoT + drift check; **audit hash chain now covers `created_at`** (v2, 11 tamper tests); production release gate (live + attested, no bypass); ops docs & deploy artifacts | `PHASE-10F.md`, `CI-RELEASE-10F.md`, `AUDIT-INTEGRITY-10F.md`, `FRONTEND-E2E-10F.md` |

---

## Doc index (Phase 10F, canonical)

| Doc | Topic |
|---|---|
| `PHASE-10F.md` | Phase summary |
| `AUDIT-INTEGRITY-10F.md` | Audit hash chain, verification, off-server anchoring, GRANTs |
| `OBSERVABILITY-10F.md` | Logging/request-id, redaction, metrics, `/metrics` gating, cardinality |
| `CI-RELEASE-10F.md` | CI workflows, tokenless public cross-repo E2E, action pinning, branch protection |
| `client/docs/FRONTEND-E2E-10F.md` | Full-stack browser safety journeys, the harness, running twice, CI gate |
| `RELEASE-CHECKLIST-10F.md` | Release gate checks, known blockers, attestation |
| `OPERATIONS-RUNBOOK-10F.md` | PM2, rollout, migrations, scheduled jobs, metrics, shutdown, readiness |
| `INCIDENT-RESPONSE-10F.md` | Severity levels, per-scenario playbooks |
| `KEY-ROTATION-10F.md` | Rotating APP_KEY (+ side effects), DB/Redis/S3/Eskiz/metrics/CI secrets |
| `BACKUP-RESTORE-10F.md` | Backup/restore procedures |
| `openapi.json` | Generated OpenAPI 3.1 contract |
