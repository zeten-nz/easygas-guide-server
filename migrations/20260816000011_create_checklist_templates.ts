import type { Knex } from 'knex';

/**
 * Template side of the checklist system (loyiha.md §14, §31, §41).
 * A template has numbered versions; a version has ordered steps; a step has
 * 0..N measurement definitions (expected rules — NOT actual values).
 * Versions are immutable once PUBLISHED; jobs reference concrete versions.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('checklist_templates', (t) => {
    t.increments('id').primary();
    t.string('name', 150).notNullable().unique('uq_checklist_templates_name');
    t.string('description', 500).nullable();
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('checklist_template_versions', (t) => {
    t.increments('id').primary();
    t.integer('template_id').unsigned().notNullable().references('id').inTable('checklist_templates').onDelete('RESTRICT');
    // Sequential integer per template (v1, v2, ...) — server-generated.
    t.integer('version').unsigned().notNullable();
    // DRAFT (editable) → PUBLISHED (immutable, assignable; one per template) → ARCHIVED (immutable, historical)
    t.string('status', 20).notNullable().defaultTo('DRAFT');
    t.timestamp('published_at').nullable();
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.unique(['template_id', 'version'], 'uq_ctv_template_version');
    t.index(['template_id', 'status'], 'idx_ctv_template_status');
  });

  // Step definitions per version (§14: name, description, requirements,
  // required_photos, stop, risk_weight, order). Editable only while the
  // version is DRAFT — enforced in the service layer.
  await knex.schema.createTable('checklist_steps', (t) => {
    t.increments('id').primary();
    t.integer('version_id').unsigned().notNullable().references('id').inTable('checklist_template_versions').onDelete('RESTRICT');
    t.integer('sort_order').unsigned().notNullable();
    t.string('name', 200).notNullable();
    t.string('description', 1000).nullable();
    t.string('requirements', 1000).nullable();
    // Data for later phases (§17 STOP, §21 risk, §19 photos) — stored now so
    // the schema needs no destructive change; no behavior attached yet.
    t.boolean('is_stop').notNullable().defaultTo(false);
    t.integer('risk_weight').unsigned().notNullable().defaultTo(0);
    t.integer('required_photos').unsigned().notNullable().defaultTo(0);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.index(['version_id', 'sort_order'], 'idx_checklist_steps_version_order');
  });

  // Measurement DEFINITIONS (§16: unit/min/max/expected/required) — the rule,
  // never the actual value. Inclusive boundaries. DECIMAL(12,3) for precision.
  await knex.schema.createTable('checklist_step_measurements', (t) => {
    t.increments('id').primary();
    t.integer('step_id').unsigned().notNullable().references('id').inTable('checklist_steps').onDelete('CASCADE');
    t.string('name', 150).notNullable();
    t.string('unit', 30).notNullable();
    t.decimal('min_value', 12, 3).nullable();
    t.decimal('max_value', 12, 3).nullable();
    t.decimal('expected_value', 12, 3).nullable();
    t.boolean('required').notNullable().defaultTo(true);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index(['step_id'], 'idx_csm_step');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('checklist_step_measurements');
  await knex.schema.dropTableIfExists('checklist_steps');
  await knex.schema.dropTableIfExists('checklist_template_versions');
  await knex.schema.dropTableIfExists('checklist_templates');
}
