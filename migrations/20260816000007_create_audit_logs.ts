import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id').primary();
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('action', 50).notNullable();
    t.string('entity_type', 50).nullable();
    t.string('entity_id', 50).nullable();
    t.json('old_value').nullable();
    t.json('new_value').nullable();
    t.string('ip', 45).nullable();
    t.string('user_agent', 500).nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index(['user_id'], 'idx_audit_logs_user');
    t.index(['action'], 'idx_audit_logs_action');
    t.index(['created_at'], 'idx_audit_logs_created');
    t.index(['entity_type', 'entity_id'], 'idx_audit_logs_entity');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_logs');
}
