# Phase 11B — Product & Service Catalogue + Reference Data

Focused implementation + verification note. Summary lives in `PROJECT_STATUS.md`. Branch
`phase/11B-catalog-reference-data` — server from `origin/main` (`04a888c`, after the Phase 11A
merge); the client branch is **stacked on `phase/11A-admin-workspace`** (`5806d82`) because it reuses
the 11A shell/Pagination/DropdownMenu/`useTableParams` and client `main` does not yet have them.
**Local only — no GitHub Actions run for this branch.**

This phase preserves every prior guarantee: authentication, the forced-password-change gate, session
rotation, CSRF, server RBAC + branch scoping, audit integrity, evidence storage, and immutable
checklist/signature/completion history. Nothing in the job/safety domain is touched — **job billing is
out of scope**, so no catalogue price is ever attached to a historical job.

## Data model (migration `20260908000003_create_catalog_and_reference_data`)

Reference tables (each ACTIVE/ARCHIVED soft state; FKs are **RESTRICT** everywhere):
- `catalog_companies` — company / catalogue group (e.g. EASY GAS, EAST ENERGE). **Distinct from brand.**
- `catalog_brands` — manufacturer / equipment brand. A different field from company.
- `product_categories`, `service_categories` — categories (normalized on write, see below).
- `catalog_units` — units of measure (`code` + name).
- `injection_reference` — engine injection values (see **Injection** below).
- Service centres reuse the existing `branches` table — **no second branch registry**.

Entities:
- `products` — `code`, `name`, `company_id`, `brand_id?`, `category_id`, `unit_id?`, `price_minor?`,
  `currency`, `status`, `version`, `source`/`source_ref`, `created_by`/`updated_by`, timestamps.
  **Code uniqueness scope: PER COMPANY** (`uq_products_company_code`) — two catalogue groups may reuse a
  code. Indexes on status/category/brand/company/name/code back the list filters.
- `services` — `code` (globally unique), `name`, `category_id`, `duration_minutes?` (explicit unit:
  minutes), `price_minor?`, `currency`, `price_basis`, `tax_rate_bp?`, `price_inclusive_minor?`,
  `status`, `version`, provenance, timestamps.
- `catalog_price_history` — polymorphic (`entity_type` product|service, `entity_id`), old/new price,
  currency, price basis snapshot, `changed_by`, reason, `source`, `created_at`.

### Money — exact fixed-point, never floating point
Prices are integer **minor units** (`price_minor` BIGINT, scale 2: 1 UZS = 100 minor). **`NULL` =
unknown price; `0` = a real zero/free price** — always distinguished. The API takes and returns integer
minor units so no float ever touches an authoritative price; the client only formats (`lib/money.ts`).
Bounds are validated (`0 … 1e12` minor). Initial currency is UZS.

### Tax semantics — the prototype's "12% VAT" is NOT assumed
Services carry an **explicit** `price_basis` (`NET` base / `GROSS` tax-inclusive / `UNKNOWN`), an
optional `tax_rate_bp` (basis points, stored **only when actually known**), and an optional
source-provided `price_inclusive_minor` kept for provenance. No universal tax policy is baked in.

### Optimistic concurrency + atomic price history
`products`/`services` carry an integer `version`. Update requires the caller's `version`; a mismatch
returns **`409 STALE_WRITE`** (the row is also locked `FOR UPDATE`, so concurrent editors serialize and
the second sees the bumped version). A price change writes its `catalog_price_history` row **inside the
same transaction** as the row update and the `*_PRICE_CHANGED` audit entry — all atomic. Newly-assigned
references are locked `FOR UPDATE` during validation, so a concurrent reference **delete** can never race
a create into a raw FK error: it either blocks (then sees the new row → `REFERENCE_IN_USE`) or wins
(then the create's locking read finds the row gone → `INVALID_*`). Audit chain head is locked last.

### Injection modelling (greenfield — no existing injection field anywhere)
Modelled to keep independent concepts independent, **not** one flat enum:
- `technology` — the injection technology: `PORT_MULTIPOINT` | `DIRECT` | `UNKNOWN`. Independent of brand.
- `forced_induction` — a **separate** attribute: `NONE` | `TURBO` | `SUPERCHARGED` | `UNKNOWN`. Turbo is
  never an injection technology.
- `designation` — the manufacturer label (MPI, GDI, FSI…). FSI, for example, is a manufacturer
  designation associated with DIRECT injection.
Every field supports `UNKNOWN`. There is no legacy injection data to migrate (no prior field existed),
so nothing is silently remapped; compatibility is never inferred from a label.

## Reference-data rules
- Whitespace is collapsed and trimmed for **duplicate detection**; casing is preserved for display.
  Only an exact post-normalization match is a duplicate (`409 REFERENCE_DUPLICATE`) — **no fuzzy merge**.
- Archive is always available. **Delete is allowed only when unused**; a referenced value returns
  `409 REFERENCE_IN_USE` (archive instead). Eligibility is re-checked transactionally under a row lock,
  and the DB FK RESTRICT is the untouched backstop — no cascade-delete of business data.

## API + authorization
- **`catalog.view`** (read) = ADMIN, RAHBAR, SIFAT. **`catalog.manage`** (create/edit/price/archive/
  delete) = **ADMIN only**. Enforced on the server; CSRF + forced-change gate + standard errors + audit
  apply to every mutation.
- Routers: `/products`, `/services`, `/reference/{kind}` (companies|brands|product-categories|
  service-categories|units), `/injection-reference`. List endpoints: bounded pagination
  (`limit 1–100`, default 25), deterministic sort with an **id tie-breaker**, accurate filtered totals,
  code/name search, company/brand/category/status filters, an **allowlisted** `sort` field set, backed by
  indexes. Selectors use the same bounded/searchable list endpoints — the catalogue is never downloaded
  whole for client-side filtering.
- Errors are stable codes: `PRODUCT_CODE_TAKEN` / `SERVICE_CODE_TAKEN`, `STALE_WRITE`,
  `REFERENCE_DUPLICATE`, `REFERENCE_IN_USE`, `STATUS_UNCHANGED`, `INVALID_COMPANY|CATEGORY|BRAND|UNIT`,
  `INVALID_PRICE`, `CODE_REQUIRED`. OpenAPI regenerated (**119 ops / 90 paths**, no route drift).

## Safe import (`npm run catalog:import -- <file> [--format json|html] [--apply] [--actor <id>]`)
- The source is parsed as **DATA only** — its embedded scripts are never executed (no eval/`new
  Function`). JSON is canonical; a best-effort extractor pulls the `PARTS`/`LABOR` array literals out of
  the owner HTML prototype as text and `JSON.parse`s them (strict JSON only, else reported).
- **DRY-RUN by default** (no writes): reports inserts, existing (skipped), invalid/missing fields, and
  the reference values that would be created. **`--apply`** is **INSERT-ONLY** and idempotent — existing
  rows (matched by code) are never overwritten, so a re-import can't duplicate entries **or silently
  clobber a later manual edit**; missing references are created with `IMPORT` provenance. Imported prices
  are recorded in price history with `source=IMPORT` and are **provisional — not approved business
  prices**. Everything runs in **one transaction** (all-or-nothing → a fixed re-run is safe).
- **Safety guard:** `--apply` is refused unless `DB_NAME` ends with `_test` (fail-closed). No
  automatic production-price seed exists in any migration.

### Owner prototype — verified against the REAL file
The owner prototype `EasyGas_Elektron_Cheklist(2).html` was provided beside the repos and parsed AS DATA
(never executed). Its data are JS object literals with unquoted keys, so `parseHtmlSource` extracts each
`{...}` object's `key: "string" | number` pairs by regex (no eval/`new Function`) and maps them:

- **PARTS `{c,co,cat,n,brand,price}` → product.** `price` is **VAT-inclusive** som (the prototype marks
  products "QQS ichida", `QQS=0.12`) → `priceMinor = price*100`; `co`=company, `brand`=manufacturer
  (kept DISTINCT).
- **LABOR `{c,cat,n,base,min,t}` → service.** `base` is the **NET (QQSsiz)** som price → `priceMinor =
  base*100`, `priceBasis=NET`, `taxRateBp=1200`, and the source's own `round(base*1.12)` (QQS bilan) is
  preserved as `priceInclusiveMinor`. This 12% is the SOURCE's per-row service convention, recorded as
  tax metadata — not applied globally.

Dry-run + apply (isolated `easygas_test` only) results — **matching the expected source counts**:
`products 219 (EASY GAS 158, EAST ENERGE 61)`, `services 63`, `companies 2`, `brands 13`,
`service-categories 10`, `product-categories 22`. **0 missing required fields, 0 duplicate codes, 0
rejected records.** Money mapped exactly (e.g. `EG-105` = `90 750 000` minor; `X01` NET `7 000 000` /
inclusive `7 840 000` / bp 1200). Normalization finding: **23 distinct category strings, but `REDUKTOR`
/ `Reduktor` differ only by case → they normalize to ONE category (22 total)**; the case-insensitive
dedup merges case variants only — DIFFERENT spellings (e.g. `EMULATORLAR` vs `EMULYATOR`, `VARIYATOR`)
are kept separate (no fuzzy matching) and left for human review. Some `brand` values coincide with a
company name (e.g. `EASY GAS`, `UZBEKISTAN`) — that is the source data, kept in the separate brand field.

Verified on `easygas_test`: dry-run writes nothing; apply persists the counts above with exact prices and
company≠brand; **re-import inserts nothing (idempotent)**; a **manual price edit survives re-import**; a
mid-apply DB failure **rolls the whole batch back (no partial writes)**.

### Production-import restriction (honest status)
The apply has been performed **only against the isolated `easygas_test` database**, and the CLI
**refuses `--apply` unless `DB_NAME` ends with `_test`** (fail-closed). The production/developer
`easygas` database has **not** been imported, seeded, or migrated with catalogue data — the production
import is **not performed and not operationally complete**. Approving imported prices as real business
prices, and running the production import, remain deliberate future operator steps.

## Verification (run locally, isolated `*_test` DB only)
- Server: `npm run test:catalog` (21 cases) + `npm run test:all` (**30 suites / 417 / 0**); `typecheck`,
  `build`, `openapi:check`. Migration **up → down → up** verified on `easygas_test`. Prod + full audit **0**.
- Client: `npm test` (component + `lib/money` unit), `lint`, `tsc -b`, `tsc -p tsconfig.test.json`,
  `build`. Prod audit **0**; full audit **5** dev-only (vite/vitest toolchain).
- Browser E2E (`e2e/catalog.spec.ts`, chromium + Pixel-5): references + product create, filter +
  pagination (30 fixtures), price edit → history, archive + find archived, service create, catalog.view
  read-only vs no-access refusal, in-use reference protection — plus the existing admin-workspace /
  manual-recovery / safety suites.

## Cross-repo merge order
Client 11A PR #9 is now **MERGED** (client `main` = `2157185`), and the 11B client branch has been
integrated with `origin/main` via a normal merge (so it no longer trails the 11A merge commit).
**Client 11A no longer needs merging.** Remaining order: **merge server 11B first** (the client needs
its endpoints), **then client 11B**.

## Reference selectors (search/pagination)
Every reference picker (product/service form company/brand/category/unit + the list filters) is a
`RefCombobox` — a bounded, server-backed searchable combobox (`useInfiniteQuery`, 20/page, debounced
search, "load more"). It **never fetches the whole list**; the selected value is loaded BY ID so it
displays even when archived or beyond the current page, while the search offers ACTIVE values only (an
archived value is readable on edit but never newly selectable). Keyboard ↑/↓/Enter/Esc, and
loading/empty/error states are handled. Regression (E2E): with >100 seeded brands, a value beyond the
first page is found via search, saved, and shown on re-open; an archived selection displays with a
marker.

## Out of scope (later phases / not begun)
Inventory, stock ledger, orders, payments, invoices, procurement, job billing, photo-gallery redesign,
risk-policy redesign, Telegram/SMS, 5 WHY, offline mode, deployment. Phase 11C not started.
