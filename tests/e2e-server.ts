/**
 * Reproducible E2E API harness for the client's Playwright suite (Phase 10E).
 *
 * Importing ./helpers/test-env FIRST forces NODE_ENV=test and redirects the
 * process to the isolated *_test database (never a developer's normal DB or
 * production). It then:
 *   - installs a FAKE console SMS provider (no real Eskiz / no real SMS),
 *   - installs the in-memory storage provider (no real S3 / local disk churn),
 *   - ensures an APPROVED (ACTIVE) risk policy so safety operations are not
 *     fail-closed,
 *   - seeds one deterministic assigned in-progress-capable job for the demo USTA
 *     so the "my jobs" flow has data,
 *   - starts the API on E2E_API_PORT (default 4000, the port Vite proxies /api to).
 *
 * Redis is the in-memory implementation under NODE_ENV=test (Phase 10C
 * RedisLike). One-command run: `npm run test:e2e:serve` (this runs test:setup
 * first). Stop with Ctrl+C. The client Playwright `webServer` starts this
 * automatically; see client/playwright.config.ts.
 */
import './helpers/test-env';
// The browser E2E specs log the same demo user in across many tests/re-runs;
// disable the abuse rate-limiters for THIS test-only harness (read per-request,
// strictly non-production, never set by the `test:all` ratelimit suite).
process.env.E2E_DISABLE_RATE_LIMIT = '1';
import { assertTestDatabase } from './helpers/test-env';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { setSmsProviderForTesting } from '../src/sms';
import { setStorageProviderForTesting } from '../src/storage';
import { MemoryStorageProvider } from './helpers/memory-storage';
import { createTemplate, addStep, publishVersion, listAssignableTemplates } from '../src/modules/checklist/templates.service';
import { ROLE_PERMISSIONS } from '../src/rbac/permissions';
import type { AuthUser } from '../src/types/auth';

const PORT = Number(process.env.E2E_API_PORT ?? 4000);

async function ensureActivePolicy(): Promise<void> {
  const v1 = await db('risk_matrix_versions').where({ version: 'v1' }).first();
  if (!v1) return; // migration seeds v1; nothing to do if the schema is absent
  if (v1.status === 'ACTIVE') return;
  const admin = await db('users')
    .join('roles', 'roles.id', 'users.role_id')
    .where('roles.code', 'ADMIN')
    .whereNull('users.deleted_at')
    .select('users.id')
    .first();
  await db('risk_matrix_versions').where({ status: 'ACTIVE' }).whereNot({ id: v1.id }).update({ status: 'RETIRED' });
  await db('risk_matrix_versions').where({ id: v1.id }).update({
    status: 'ACTIVE',
    approved_by: admin?.id ?? null,
    approved_at: db.raw('CURRENT_TIMESTAMP(6)'),
    rationale: 'E2E harness — provisional v1 activated for browser tests only',
  });
}

/**
 * Seeds one PUBLISHED checklist template (via the real validated template
 * service, as an ADMIN actor) so the browser can drive checklist assignment.
 * Simple steps (no required photos / measurements / STOP) keep the happy-path
 * deterministic. Best-effort: never blocks API startup.
 */
async function ensurePublishedTemplate(): Promise<void> {
  try {
    if ((await listAssignableTemplates()).some((t) => t.name === 'E2E Checklist')) return;
    const adminRow = await db('users').join('roles', 'roles.id', 'users.role_id').where('roles.code', 'ADMIN').whereNull('users.deleted_at').select('users.*').first();
    if (!adminRow) return;
    const actor: AuthUser = {
      id: adminRow.id,
      firstName: adminRow.first_name,
      lastName: adminRow.last_name,
      phone: adminRow.phone,
      region: adminRow.region,
      branchId: adminRow.branch_id ?? null,
      role: 'ADMIN',
      status: 'ACTIVE',
      avatarUrl: null,
      permissions: ROLE_PERMISSIONS.ADMIN,
    };
    const meta = { ip: null, userAgent: null };
    const tpl = await createTemplate(actor, { name: 'E2E Checklist', description: 'Deterministic template for browser E2E' }, meta);
    const versionId = tpl.versions[0].id;
    await addStep(actor, tpl.id, versionId, { name: 'E2E Step One', isStop: false, riskWeight: 0, requiredPhotos: 0, measurements: [] }, meta);
    await addStep(actor, tpl.id, versionId, { name: 'E2E Step Two', isStop: false, riskWeight: 0, requiredPhotos: 0, measurements: [] }, meta);
    await publishVersion(actor, tpl.id, versionId, meta);
    console.log('[e2e-server] seeded published "E2E Checklist" template');
  } catch (err) {
    console.warn('[e2e-server] template seed skipped:', err instanceof Error ? err.message : err);
  }
}

/**
 * One deterministic assigned job for the demo USTA so /app/my-jobs is not empty.
 * Best-effort: a seeding hiccup must never prevent the API from starting, so any
 * error is logged and swallowed.
 */
async function ensureSeedJob(): Promise<void> {
  try {
    const usta = await db('users').where({ phone: '+998901000001' }).first();
    if (!usta) return;
    if (await db('jobs').where({ assigned_technician_id: usta.id }).first()) return;

    let customer = await db('customers').where({ name: 'E2E Demo Mijoz' }).first();
    if (!customer) {
      const [cid] = await db('customers').insert({ name: 'E2E Demo Mijoz', phone: '+998900009999', created_by: usta.id });
      customer = await db('customers').where({ id: cid }).first();
    }
    let vehicle = await db('vehicles').where({ plate_number: 'E2E001' }).first();
    if (!vehicle) {
      const [vid] = await db('vehicles').insert({ customer_id: customer.id, plate_number: 'E2E001', make: 'Chevrolet', model: 'Cobalt', created_by: usta.id });
      vehicle = await db('vehicles').where({ id: vid }).first();
    }
    const [jobId] = await db('jobs').insert({
      customer_id: customer.id,
      vehicle_id: vehicle.id,
      branch_id: usta.branch_id,
      status: 'DRAFT',
      created_by: usta.id,
      assigned_technician_id: usta.id,
      assignment_status: 'ASSIGNED',
      cycle: 1,
    });
    await db('job_assignments').insert({ job_id: jobId, cycle: 1, technician_id: usta.id, assigned_by: usta.id, provenance: 'SELF_AT_CREATION' });
    console.log(`[e2e-server] seeded assigned job #${jobId} for demo USTA`);
  } catch (err) {
    console.warn('[e2e-server] seed job skipped:', err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  await assertTestDatabase(db); // fail-closed: refuse any non-*_test database
  setSmsProviderForTesting({
    name: 'e2e-console',
    send: async (phone: string, message: string) => {
      console.log(`[e2e-sms] ${phone}: ${message}`);
      return { providerMessageId: null, outcome: 'ACCEPTED' as const };
    },
  });
  setStorageProviderForTesting(new MemoryStorageProvider());
  await ensureActivePolicy();
  await ensurePublishedTemplate();
  await ensureSeedJob();

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`[e2e-server] API listening on http://127.0.0.1:${PORT} (DB=${process.env.DB_NAME}) — fake SMS, memory storage, policy ACTIVE`);
  });

  const shutdown = () => { server.close(() => db.destroy().finally(() => process.exit(0))); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[e2e-server] failed to start:', err);
  process.exit(1);
});
