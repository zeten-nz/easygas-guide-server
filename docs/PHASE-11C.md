# Phase 11C — Evidence Review UX & Understandable Risk Policy

Read-only server additions that power (A) completed-job **photo-evidence browsing**,
(B) an accessible photo viewer, and (C/D) a clearer **risk-policy** explanation,
illustrative preview, and history/approval UX. No safety thresholds, approval
authority, or business rules changed. No migration was required — the existing model
already carried everything needed.

## Scope guardrails honoured

- No new automatic risk-assessment rules; no retrospective reclassification of risk
  events; no change to safety thresholds or approval authority.
- No developer/production policy activated; no production data touched.
- Evidence is **read-only** here — no upload/delete/replace surface added to
  completed-job review; downloads reuse the existing READY-only endpoint.

## Evidence — what is true, and what this exposes

The existing evidence model (Phase 10B/10D) is unchanged and its honesty rules are
preserved verbatim:

- `job_photos` has **no cycle column and no capture time**. A photo's completed
  **cycle is derived ONLY from the immutable `completion_snapshots`** (which froze
  the exact evidence `photoId`s per cycle) — never inferred from today's `jobs.cycle`,
  `jobs.assigned_technician_id`, or `jobs.status`.
- Only `status = 'READY'` is real evidence. `PENDING` (in-flight), `UNVERIFIED`
  (pre-10B legacy, never verified) and `FAILED` rows are surfaced with their state,
  never as accessible evidence. A DB row / a URL is **not** proof of verification.
- The uploader (`job_photos.created_by`) is the **actual performer of that upload**,
  distinct from the job's current responsible technician (`assigned_technician_id`).

### New API — `GET /api/v1/jobs/:id/photos`

Permission `jobs.view`; branch-scoped (an out-of-scope job → **404**, never 403).
Job-level, cross-step, cross-cycle listing with bounded pagination
(`page`, `limit≤100`, default 50) and optional `cycle` / `jobStepId` filters. Each
row carries: `status`, `attempt`, `stepName`/`stepOrder`/`isStop`/`requiredPhotos`,
`uploadedById`/`uploadedByName`, `createdAt`/`readyAt`, `sizeBytes`/`mimeType`, the
derived `cycle` (or `null`), `snapshotEvidence`, `downloadable` (only READY), and a
server-computed **`role`**:

| role | meaning |
|---|---|
| `COMPLETED_CYCLE` | READY and frozen into a completed cycle's snapshot (authoritative history) |
| `CURRENT` | READY, the step's current attempt, on a workable (in-progress/reopened) job |
| `SUPERSEDED_ATTEMPT` | READY but an earlier attempt not carried into any snapshot |
| `PENDING` / `UNVERIFIED` / `FAILED` | not (yet / ever) valid evidence — shown, not served |

A `cycle` filter returns exactly that cycle's snapshot evidence (a complete group, no
partial page). The listing performs **no N+1** (one snapshot read + one grouped
join). Implementation: `src/modules/photos/job-evidence.service.ts`.

### Downloads — the existing endpoint, no bypass

Image bytes are still streamed by the pre-existing **READY-only** endpoint
`GET /api/v1/jobs/:jobId/checklist/steps/:stepId/photos/:photoId/file` (auth +
branch-scoped, `X-Content-Type-Options: nosniff`, inline synthetic filename, never the
storage key). There are **no signed/pre-signed URLs** anywhere in the system; a
frontend link is not access control — the endpoint re-checks READY + branch on every
request, and 404s for an out-of-branch/unverified/missing object. No new download
route was added.

### Completed-job list filters (additive)

`GET /api/v1/jobs` gained optional, allowlisted `technicianId`, `dateFrom`, `dateTo`
(YYYY-MM-DD, inclusive, on `created_at`) alongside the existing `search`/`status`/
`branchId`. Branch scoping is unchanged — a scoped actor can never widen scope.

### Performance / bandwidth limitation (stated honestly)

The system stores **no thumbnails/derivatives** — the only image size is the original.
The gallery therefore lazy-loads originals (reserved boxes, `loading="lazy"`,
incremental pagination) rather than fetching every full-resolution image at once, but
each opened thumbnail is still the original. Adding a controlled derivative pipeline
(preserving originals, generated through the storage flow, never marked as the
original) is deferred; it is **out of scope** here and no external image/CDN service
was added.

## Risk policy — display, preview, history

Rendered entirely from **server-provided definitions**; no thresholds are hardcoded
anywhere on the client, and the matrix is defined once on the server.

### New API (read-only, `risk.matrix.approve` = SIFAT/ADMIN)

- `GET /api/v1/risk-policy/versions/:version` — one version's immutable `definition`,
  the **server-computed classified grid** (`cells`: every severity×likelihood →
  score/level/blocking, via the SHARED evaluator `classify`), approver/rationale
  provenance (with `approvedByName` resolved, id fallback), `supersededBy`, and
  `blockedOperations` (the operations a blocking-level risk prevents).
- `GET /api/v1/risk-policy/versions/:version/preview?severity=&likelihood=&source=` —
  an **illustrative** classification of the chosen version's definition using the same
  `classify`. It creates **no** risk event, activates nothing, and works for
  DRAFT/ACTIVE/RETIRED. It is explicitly an example (`example: true`), **distinct** from
  production `assessRisk`, which still requires an ACTIVE policy and **fails closed**
  (`409 RISK_POLICY_NOT_APPROVED`) otherwise — a DRAFT preview never makes a DRAFT
  usable for a real assessment. Out-of-range severity/likelihood → `422`.

`GET /risk-policy/versions` now also returns `approvedByName` and `supersededBy`.

### Provisional vs approved (provenance ≠ lifecycle)

"Provisional" describes the **definition's provenance** (v1 was author-chosen during
implementation), not a lifecycle state. The three stored lifecycle states remain
`DRAFT / ACTIVE / RETIRED`. An ACTIVE version that originated as provisional v1 is
**approved** — the UI does not mislabel it "unapproved". Approval, immutability, the
one-ACTIVE invariant, the singleton activation lock, audit events, and the fail-closed
gate are all unchanged and untouched by these read endpoints.

## OpenAPI

Regenerated: **122 operations / 93 paths, no route drift** (`npm run openapi:check`).
Added the three routes above; also corrected the create-version request `version` type
(string, was mistakenly `integer`).

## Tests (executed locally on the isolated `*_test` DB)

- `npm run test:job-evidence` — **7/7**: truthful roles across a REAL completed →
  reopened → re-worked job (COMPLETED_CYCLE / SUPERSEDED_ATTEMPT / CURRENT) plus
  legacy UNVERIFIED + FAILED rows; cycle filter; bounded pagination; branch isolation
  (404); READY-only download (unverified/legacy/cross-branch → 404); forced-password
  gate; and the additive list filters.
- `npm run test:riskpolicy-preview` — **7/7**: detail definition matches the stored
  row and the computed grid matches the shared evaluator; preview agrees with the
  evaluator at threshold boundaries + source overrides; preview writes no risk/policy
  mutation; a DRAFT preview does not make a DRAFT usable (assessRisk still fails
  closed); unauthorized (USTA) → 403; out-of-range → 422; approver-name resolution.
- Full `npm run test:all` green (all suites) with these added; typecheck + build +
  `openapi:check` clean.

The Playwright harness (`tests/e2e-server.ts`) now also seeds `E2E-EVI-<proj>`
(COMPLETED with a photo) and `E2E-EVR-<proj>` (COMPLETED → REOPENED, carrying cycle-1
historical evidence + a cycle-2 current photo) via the real workflow services, for the
client browser E2E — reported in the boot preflight (`evidenceJobs`).

## Cross-repo compatibility & merge order

The client Phase 11C branch needs these new server endpoints (`GET /jobs/:id/photos`,
`GET /risk-policy/versions/:version`, `.../preview`) and the additive list filters, so
**merge the server PR first, then the client PR** — its `e2e-fullstack` default gate
(client branch × server `main`) goes green only once server `main` carries them. Base
refs: server `4df8c91`, client `de0dc1f` (both post-11B). Compatible refs to validate
before merge: dispatch the client `e2e-fullstack` with
`server_ref=phase/11C-evidence-risk-ux` and the server mirror with
`client_ref=phase/11C-evidence-risk-ux`.
