import type { Knex } from 'knex';

/**
 * Phase 11B — Product & Service catalogue + supporting reference data.
 *
 * Design decisions (see docs/PHASE-11B.md for the full rationale):
 *
 * MONEY — exact fixed-point, never floating point. Prices are stored as
 * `price_minor` BIGINT = integer count of the currency's MINOR unit (scale 2:
 * 1 UZS = 100 minor). NULL price_minor = price UNKNOWN; 0 = a genuine zero/free
 * price. `currency` is an ISO-4217 code, default 'UZS'. All arithmetic stays in
 * integer minor units.
 *
 * REFERENCE DATA — companies (catalogue groups), brands (manufacturer, a
 * DIFFERENT field from company), product/service categories, units, and engine
 * injection reference values. Each is a real table with ACTIVE/ARCHIVED soft
 * state; FKs are RESTRICT so referenced rows can never be hard-deleted or
 * cascade away business data. Service centres reuse the existing `branches`
 * table — no second branch registry is created here.
 *
 * INJECTION — modelled properly, not as one flat enum: a `technology`
 * (port/multipoint vs direct — independent of brand) is separate from the
 * `forced_induction` attribute (Turbo/supercharged is NOT an injection
 * technology). `designation` is the manufacturer label (MPI, GDI, FSI…). Every
 * field supports an UNKNOWN value.
 *
 * CONCURRENCY — products and services carry an integer `version` for optimistic
 * concurrency (stale-edit detection); price changes are recorded in
 * `catalog_price_history` atomically with the row update.
 */
export async function up(knex: Knex): Promise<void> {
  // Idempotent creates: a partially-applied state (tables present but this
  // migration unrecorded — e.g. after a bookkeeping-only restore) must re-run
  // safely. Each table is created only when absent; existing tables are left
  // untouched (their schema is verified to match this definition out-of-band).
  const createIfMissing = async (
    name: string,
    build: (t: Knex.CreateTableBuilder) => void,
  ): Promise<void> => {
    if (!(await knex.schema.hasTable(name))) {
      await knex.schema.createTable(name, build);
    }
  };

  // --- Reference: companies / catalogue groups (e.g. EASY GAS, EAST ENERGE) ---
  await createIfMissing('catalog_companies', (t) => {
    t.increments('id').primary();
    t.string('name', 150).notNullable().unique('uq_catalog_companies_name');
    t.string('status', 20).notNullable().defaultTo('ACTIVE'); // ACTIVE | ARCHIVED
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['status'], 'idx_catalog_companies_status');
  });

  // --- Reference: manufacturer / equipment brands (distinct from company) ---
  await createIfMissing('catalog_brands', (t) => {
    t.increments('id').primary();
    t.string('name', 150).notNullable().unique('uq_catalog_brands_name');
    t.string('status', 20).notNullable().defaultTo('ACTIVE');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['status'], 'idx_catalog_brands_status');
  });

  // --- Reference: product categories ---
  await createIfMissing('product_categories', (t) => {
    t.increments('id').primary();
    t.string('name', 150).notNullable().unique('uq_product_categories_name');
    t.string('status', 20).notNullable().defaultTo('ACTIVE');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['status'], 'idx_product_categories_status');
  });

  // --- Reference: service categories ---
  await createIfMissing('service_categories', (t) => {
    t.increments('id').primary();
    t.string('name', 150).notNullable().unique('uq_service_categories_name');
    t.string('status', 20).notNullable().defaultTo('ACTIVE');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['status'], 'idx_service_categories_status');
  });

  // --- Reference: units of measure (code + human name) ---
  await createIfMissing('catalog_units', (t) => {
    t.increments('id').primary();
    t.string('code', 30).notNullable().unique('uq_catalog_units_code');
    t.string('name', 60).notNullable();
    t.string('status', 20).notNullable().defaultTo('ACTIVE');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['status'], 'idx_catalog_units_status');
  });

  // --- Reference: engine injection values (technology ⟂ forced induction) ---
  await createIfMissing('injection_reference', (t) => {
    t.increments('id').primary();
    // Manufacturer designation label, e.g. MPI / GDI / FSI / TSI. Unique.
    t.string('designation', 60).notNullable().unique('uq_injection_reference_designation');
    // Injection TECHNOLOGY — independent of brand and of forced induction.
    // PORT_MULTIPOINT | DIRECT | UNKNOWN
    t.string('technology', 30).notNullable().defaultTo('UNKNOWN');
    // Forced induction is a SEPARATE attribute — Turbo is never an injection
    // technology. NONE | TURBO | SUPERCHARGED | UNKNOWN
    t.string('forced_induction', 20).notNullable().defaultTo('UNKNOWN');
    t.string('description', 500).nullable();
    t.string('status', 20).notNullable().defaultTo('ACTIVE');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['status'], 'idx_injection_reference_status');
    t.index(['technology'], 'idx_injection_reference_technology');
  });

  // --- Products ---
  await createIfMissing('products', (t) => {
    t.increments('id').primary();
    // SKU/code. Uniqueness scope: PER COMPANY (catalogue group) — two groups may
    // legitimately reuse a code. Enforced by uq_products_company_code below.
    t.string('code', 60).notNullable();
    t.string('name', 200).notNullable();
    t.integer('company_id').unsigned().notNullable().references('id').inTable('catalog_companies').onDelete('RESTRICT');
    t.integer('brand_id').unsigned().nullable().references('id').inTable('catalog_brands').onDelete('RESTRICT');
    t.integer('category_id').unsigned().notNullable().references('id').inTable('product_categories').onDelete('RESTRICT');
    t.integer('unit_id').unsigned().nullable().references('id').inTable('catalog_units').onDelete('RESTRICT');
    // Money: exact integer minor units (scale 2). NULL = unknown, 0 = free.
    t.bigInteger('price_minor').nullable();
    t.string('currency', 3).notNullable().defaultTo('UZS');
    t.string('status', 20).notNullable().defaultTo('ACTIVE'); // ACTIVE | ARCHIVED
    // Optimistic concurrency: bumped on every mutation; stale writes are refused.
    t.integer('version').unsigned().notNullable().defaultTo(1);
    // Provenance — imported prices are provisional, NOT approved business prices.
    t.string('source', 30).notNullable().defaultTo('MANUAL'); // MANUAL | IMPORT
    t.string('source_ref', 120).nullable(); // original code/row in the import source
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.unique(['company_id', 'code'], 'uq_products_company_code');
    t.index(['status'], 'idx_products_status');
    t.index(['category_id'], 'idx_products_category');
    t.index(['brand_id'], 'idx_products_brand');
    t.index(['company_id'], 'idx_products_company');
    t.index(['name'], 'idx_products_name');
    t.index(['code'], 'idx_products_code');
  });

  // --- Services ---
  await createIfMissing('services', (t) => {
    t.increments('id').primary();
    t.string('code', 60).notNullable().unique('uq_services_code');
    t.string('name', 200).notNullable();
    t.integer('category_id').unsigned().notNullable().references('id').inTable('service_categories').onDelete('RESTRICT');
    // Duration with an EXPLICIT unit (minutes). NULL = unspecified.
    t.integer('duration_minutes').unsigned().nullable();
    // Money — the authoritative price (minor units, scale 2). NULL = unknown.
    t.bigInteger('price_minor').nullable();
    t.string('currency', 3).notNullable().defaultTo('UZS');
    // Price basis / tax metadata. The prototype's "12% VAT" is NOT assumed here:
    // basis is explicit (NET base price / GROSS tax-inclusive / UNKNOWN), and any
    // tax rate is stored as basis points only when actually known.
    t.string('price_basis', 20).notNullable().defaultTo('UNKNOWN'); // NET | GROSS | UNKNOWN
    t.integer('tax_rate_bp').unsigned().nullable(); // e.g. 1200 = 12.00%, NULL = unknown
    // Source-provided tax-inclusive amount, preserved for provenance (never derived).
    t.bigInteger('price_inclusive_minor').nullable();
    t.string('status', 20).notNullable().defaultTo('ACTIVE');
    t.integer('version').unsigned().notNullable().defaultTo(1);
    t.string('source', 30).notNullable().defaultTo('MANUAL');
    t.string('source_ref', 120).nullable();
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.index(['status'], 'idx_services_status');
    t.index(['category_id'], 'idx_services_category');
    t.index(['name'], 'idx_services_name');
  });

  // --- Price-change history (products & services) — actor, time, prev → new ---
  await createIfMissing('catalog_price_history', (t) => {
    t.increments('id').primary();
    t.string('entity_type', 20).notNullable(); // 'product' | 'service'
    t.integer('entity_id').unsigned().notNullable();
    t.bigInteger('old_price_minor').nullable();
    t.bigInteger('new_price_minor').nullable();
    t.string('currency', 3).notNullable().defaultTo('UZS');
    t.string('price_basis', 20).nullable(); // services only; snapshot at change time
    t.integer('changed_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('reason', 500).nullable();
    t.string('source', 30).notNullable().defaultTo('MANUAL'); // MANUAL | IMPORT
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index(['entity_type', 'entity_id', 'created_at'], 'idx_price_history_entity');
  });
}

export async function down(knex: Knex): Promise<void> {
  // Drop in reverse dependency order (children/back-references first).
  await knex.schema.dropTableIfExists('catalog_price_history');
  await knex.schema.dropTableIfExists('services');
  await knex.schema.dropTableIfExists('products');
  await knex.schema.dropTableIfExists('injection_reference');
  await knex.schema.dropTableIfExists('catalog_units');
  await knex.schema.dropTableIfExists('service_categories');
  await knex.schema.dropTableIfExists('product_categories');
  await knex.schema.dropTableIfExists('catalog_brands');
  await knex.schema.dropTableIfExists('catalog_companies');
}
