# Phase 11A — Admin Workspace, Employee Profiles, Pagination & Safe Template Deletion

Focused implementation + verification note. Summary lives in `PROJECT_STATUS.md`. Branch
`phase/11A-admin-workspace` in both repos, based on `origin/main` (server `fe493f9`, client `c7b1997`)
after manual employee password recovery merged. **Local only — no GitHub Actions run for this branch.**

This phase preserves all prior guarantees: authentication, the forced-password-change gate, session
rotation, CSRF, RBAC, branch scoping, audit integrity, evidence storage, and immutable historical
records. No migration was needed (behavioural change only; no schema change).

## Server (API contract changes)

- **`GET /users` — employee directory.** `listUsers` now excludes the current viewer
  (`.whereNot('users.id', actor.id)` on the shared builder, so the exclusion is applied BEFORE the COUNT
  and the page — the filtered total never includes the caller). Only the caller is hidden; other users,
  including other admins, remain. Deterministic order gained an id tie-breaker
  (`created_at desc, id desc`). Bounded limit unchanged (`min 1, max 100, default 25`).
  Files: `src/modules/users/users.service.ts`.
- **`GET /users/me` — own profile (new).** `requireAuth` only, **no `users.view`** — self-scoped, returns
  the caller's own `UserDetail`; never accepts a target id. Declared before `/:id` so `me` is not parsed
  as an id. Files: `src/modules/users/users.{routes,service}.ts`.
- **`GET /users/:id` — employee profile (existing).** Unchanged authorization: out-of-scope / nonexistent
  ids → 404 (never 403); `users.view` required; the forced-change gate blocks it.
- **`DELETE /checklist-templates/:id` — delete an unused draft-only template (new).** `templates.manage`.
  Inside one transaction, lock order **template row → all version rows FOR UPDATE → audit last**; refuse
  unless every version is DRAFT (`409 TEMPLATE_HAS_HISTORY`) and no `job_checklists`/`job_steps` reference
  it (`409 TEMPLATE_IN_USE`, defensive — the RESTRICT FKs are the backstop, never weakened); delete
  children→parent (steps [measurements cascade] → versions → template); `TEMPLATE_DELETED` audit with the
  name + version count only. `listTemplates`/`getTemplate` return advisory `deletable` + `deletableReason`.
  Files: `src/modules/checklist/templates.{routes,service}.ts`, `src/modules/audit/audit.service.ts`
  (new `TEMPLATE_DELETED` action). The version publish/archive lifecycle is unchanged.
- OpenAPI (`src/openapi/spec.ts` + regenerated `docs/openapi.json`, 89 ops / 72 paths) covers the new ops
  and the directory self-exclusion note.

## Client (routes / screens)

- Redesigned shell: grouped left sidebar + top bar (page context + account menu) + accessible mobile
  drawer (`src/pages/app/{AppShell,Sidebar,ProfileMenu,nav-config}.tsx`). Brand blue = primary action,
  brand red = destructive (`Button` `primary`→blue, added solid `danger`). Task-oriented home
  (`HomePage.tsx`), no hero/analytics.
- Shared `Pagination` (`components/ui/Pagination.tsx`) + URL-state `useTableParams`
  (`lib/useTableParams.ts`); applied to the employee directory (`pages/admin/UsersPage.tsx`) and jobs
  (`pages/jobs/JobsPage.tsx`).
- Profiles: `pages/app/ProfilePage.tsx` (own, `/app/profile`), `pages/admin/UserDetailPage.tsx`
  (employee, `/app/admin/users/:id`), shared `pages/app/ProfileView.tsx`. `/change-password` now serves
  the voluntary change too (guard relaxed; copy adapts).
- Templates: status labels Qoralama/Faol/Arxivlangan + filter (`pages/admin/templates/…`), delete with a
  naming confirmation + permanent-vs-archive explanation (`DeleteTemplateDialog.tsx`), reason shown when
  ineligible, honest refetch on success/conflict.
- Accessible `DropdownMenu` primitive (`components/ui/DropdownMenu.tsx`) for the account + row menus.

## Verification (run locally)

- Server: `npm run test:admin-workspace` (13 cases) + `npm run test:all`; `npm run typecheck`,
  `npm run build`, `npm run openapi:check`.
- Client: `npm test` (58 unit/component, 14 new), `npm run lint`, `npx tsc -b`,
  `npx tsc -p tsconfig.test.json --noEmit`, `npm run build`.
- Browser E2E: `npm run test:e2e -- admin-workspace` (system Edge, `PW_CHANNEL=msedge`) — creates 55
  synthetic employees + a second admin via the API (no production/developer data), then exercises
  pagination, profile + Back, own-profile → change-password, draft create+delete, published-cannot-delete,
  mobile drawer, and no horizontal overflow at 360/768/1366/1920.

## Cross-repo merge order

Client needs the new server endpoints → **merge server first, then client**. Validate together first by
dispatching the client `e2e-fullstack` with `server_ref=phase/11A-admin-workspace` (and the server mirror
with `client_ref=phase/11A-admin-workspace`). Do not merge the client PR against a server `main` lacking
the endpoints.

## Out of scope (later phases)

Price/service catalogue, reference-data CRUD, injection-type modelling, risk-matrix redesign/policy,
photo-gallery workflows, Telegram bot/SMS, inventory, payments, notifications, offline mode, 5 WHY.
