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
import express from 'express';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { setSmsProviderForTesting } from '../src/sms';
import { setStorageProviderForTesting } from '../src/storage';
import { MemoryStorageProvider } from './helpers/memory-storage';
import { createTemplate, addStep, publishVersion, listAssignableTemplates } from '../src/modules/checklist/templates.service';
import { ROLE_PERMISSIONS } from '../src/rbac/permissions';
import type { AuthUser, RoleCode } from '../src/types/auth';
import * as jobsService from '../src/modules/jobs/jobs.service';
import * as execution from '../src/modules/checklist/execution.service';
import * as photosService from '../src/modules/photos/photos.service';
import * as completionService from '../src/modules/jobs/completion.service';

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
      mustChangePassword: Boolean(adminRow.must_change_password),
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
 * A deterministic POOL of DRAFT jobs assigned to the demo USTA — one per browser
 * workflow so the flows never contend on shared state. Each has a stable plate
 * (E2E-HAPPY / E2E-BLOCK / E2E-ASSIGN / E2E-GPS / E2E-REOPEN) the specs claim by
 * name. Prerequisites only (customer/vehicle/DRAFT job + self-assignment); the
 * tested behavior runs through the real UI. Best-effort: never blocks startup.
 */
// One DRAFT job per (flow × browser project) so destructive flows never contend
// across the shared backend — including reopen, which now runs on BOTH profiles
// (no skipped specs, so CI can fail on any skip). Plates are the stable keys the
// specs claim (E2E-<FLOW>-<cr|mo>). Short codes fit vehicles.plate_number(12):
// HAP=happy BLK=blocking ASG=assignment GPS=gps VIW=visual RE=reopen.
function buildPlates(): string[] {
  const flows = ['HAP', 'BLK', 'ASG', 'GPS', 'VIW', 'RE'];
  const projects = ['cr', 'mo'];
  const plates: string[] = [];
  for (const f of flows) for (const p of projects) plates.push(`E2E-${f}-${p}`);
  return plates;
}
const E2E_PLATES = buildPlates();

async function ensureSeedJobs(): Promise<void> {
  try {
    const usta = await db('users').where({ phone: '+998901000001' }).first();
    const master = await db('users').where({ phone: '+998901000002' }).first();
    if (!usta) return;
    let customer = await db('customers').where({ name: 'E2E Demo Mijoz' }).first();
    if (!customer) {
      const [cid] = await db('customers').insert({ name: 'E2E Demo Mijoz', phone: '+998900009999', created_by: usta.id });
      customer = await db('customers').where({ id: cid }).first();
    }
    // A second eligible technician (MASTER, same branch) so reassignment has a target.
    for (const plate of E2E_PLATES) {
      if (await db('vehicles').where({ plate_number: plate }).first()) continue;
      const [vid] = await db('vehicles').insert({ customer_id: customer.id, plate_number: plate, make: 'Chevrolet', model: 'Cobalt', created_by: usta.id });
      const [jobId] = await db('jobs').insert({
        customer_id: customer.id,
        vehicle_id: vid,
        branch_id: usta.branch_id,
        status: 'DRAFT',
        created_by: usta.id,
        assigned_technician_id: usta.id,
        assignment_status: 'ASSIGNED',
        cycle: 1,
      });
      await db('job_assignments').insert({ job_id: jobId, cycle: 1, technician_id: usta.id, assigned_by: usta.id, provenance: 'SELF_AT_CREATION' });
    }
    console.log(`[e2e-server] seeded ${E2E_PLATES.length} DRAFT jobs for demo USTA (master target: ${master ? 'yes' : 'no'})`);
  } catch (err) {
    console.warn('[e2e-server] seed jobs skipped:', err instanceof Error ? err.message : err);
  }
}

// A tiny but valid 1x1 PNG for seeded photo evidence (memory storage; not a real image).
const SEED_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// Plates for Phase 11C evidence-review flows (per browser project). EVI = a
// COMPLETED job with photo evidence; EVR = COMPLETED → REOPENED with cycle-1
// historical evidence + a cycle-2 current photo.
const EVIDENCE_PLATES = ['E2E-EVI-cr', 'E2E-EVI-mo', 'E2E-EVR-cr', 'E2E-EVR-mo'];

function seedActor(row: Record<string, any>, role: RoleCode): AuthUser {
  return { id: row.id, firstName: row.first_name, lastName: row.last_name, phone: row.phone, region: row.region, branchId: row.branch_id ?? null, role, status: 'ACTIVE', avatarUrl: null, mustChangePassword: false, permissions: ROLE_PERMISSIONS[role] };
}

/**
 * Seeds COMPLETED (and one REOPENED) jobs WITH photo evidence, driven entirely
 * through the real workflow services so the Phase 11C evidence gallery / photo
 * viewer / completed-job list have truthful data on BOTH browser projects.
 * Best-effort: never blocks API startup.
 */
async function ensureEvidenceJobs(): Promise<void> {
  const meta = { ip: null, userAgent: null };
  try {
    const ustaRow = await db('users').where({ phone: '+998901000001' }).first(); // USTA (assigned)
    const masterRow = await db('users').where({ phone: '+998901000002' }).first(); // MASTER (closes)
    const sifatRow = await db('users').where({ phone: '+998901000004' }).first(); // SIFAT (reopens)
    if (!ustaRow || !masterRow || !sifatRow) return;
    const usta = seedActor(ustaRow, 'USTA');
    const master = seedActor(masterRow, 'MASTER');
    const sifat = seedActor(sifatRow, 'SIFAT');

    // A dedicated PUBLISHED template with a required-photo step so the gallery is
    // meaningful (steps ask for a photo).
    let tpl = (await listAssignableTemplates()).find((t) => t.name === 'E2E Evidence Checklist');
    if (!tpl) {
      const created = await createTemplate(usta, { name: 'E2E Evidence Checklist', description: 'Photo evidence for 11C' }, meta);
      await addStep(usta, created.id, created.versions[0].id, { name: 'Foto bosqich', isStop: false, riskWeight: 0, requiredPhotos: 1, measurements: [] }, meta);
      await publishVersion(usta, created.id, created.versions[0].id, meta);
      tpl = (await listAssignableTemplates()).find((t) => t.name === 'E2E Evidence Checklist')!;
    }

    let customer = await db('customers').where({ name: 'E2E Evidence Mijoz' }).first();
    if (!customer) {
      const [cid] = await db('customers').insert({ name: 'E2E Evidence Mijoz', phone: '+998900008888', created_by: ustaRow.id });
      customer = await db('customers').where({ id: cid }).first();
    }

    const buildCompleted = async (plate: string): Promise<number | null> => {
      if (await db('vehicles').where({ plate_number: plate }).first()) return null; // idempotent
      const [vid] = await db('vehicles').insert({ customer_id: customer.id, plate_number: plate, make: 'Chevrolet', model: 'Nexia', created_by: ustaRow.id });
      const [jobId] = await db('jobs').insert({ customer_id: customer.id, vehicle_id: vid, branch_id: ustaRow.branch_id, status: 'DRAFT', created_by: ustaRow.id, assigned_technician_id: ustaRow.id, assignment_status: 'ASSIGNED', cycle: 1 });
      await db('job_assignments').insert({ job_id: jobId, cycle: 1, technician_id: ustaRow.id, assigned_by: ustaRow.id, provenance: 'SELF_AT_CREATION' });
      await jobsService.startJob(usta, jobId, meta);
      await execution.assignChecklist(usta, jobId, tpl!.id, meta);
      const step = await db('job_steps').join('job_checklists', 'job_checklists.id', 'job_steps.job_checklist_id').where('job_checklists.job_id', jobId).select('job_steps.id').first();
      await photosService.uploadStepPhoto(usta, jobId, step.id, { buffer: SEED_PNG, originalname: 'evidence.png' }, meta);
      await execution.completeStep(usta, jobId, step.id, { measurements: [] }, meta);
      const sum = await completionService.getSignableSummary(jobId);
      await completionService.saveSignature(usta, jobId, { buffer: SEED_PNG }, meta, sum!.digest);
      await completionService.closeJob(master, jobId, meta);
      return jobId;
    };

    for (const plate of ['E2E-EVI-cr', 'E2E-EVI-mo']) await buildCompleted(plate);

    for (const plate of ['E2E-EVR-cr', 'E2E-EVR-mo']) {
      const jobId = await buildCompleted(plate);
      if (jobId == null) continue; // already seeded
      const step = await db('job_steps').join('job_checklists', 'job_checklists.id', 'job_steps.job_checklist_id').where('job_checklists.job_id', jobId).select('job_steps.id').first();
      await completionService.reopenJob(sifat, jobId, 'Sifat nazorati — qayta tekshirish', meta);
      await execution.redoStep(usta, jobId, step.id, meta);
      await photosService.uploadStepPhoto(usta, jobId, step.id, { buffer: SEED_PNG, originalname: 'evidence-c2.png' }, meta);
    }
    console.log('[e2e-server] seeded Phase 11C evidence jobs (completed + reopened, with photos)');
  } catch (err) {
    console.warn('[e2e-server] evidence-job seed skipped:', err instanceof Error ? err.message : err);
  }
}

/**
 * Non-sensitive fixture readiness for the browser E2E harness. Reports ONLY
 * booleans/counts and the SHORT plate codes (E2E-*) the specs claim — never PII,
 * cookies, tokens, OTPs, GPS coordinates or signatures. Used by the preflight
 * endpoint and the boot self-check so a seeding failure is caught BEFORE Playwright
 * opens a browser (instead of surfacing as 12 confusing "job not found" failures).
 */
async function fixtureReadiness(): Promise<{
  ready: boolean;
  expectedPlates: number;
  seededPlates: number;
  missingPlates: string[];
  publishedTemplate: boolean;
  activeRiskPolicy: boolean;
  evidenceJobs: boolean;
}> {
  const jobRows = await db('jobs')
    .join('vehicles', 'vehicles.id', 'jobs.vehicle_id')
    .whereIn('vehicles.plate_number', E2E_PLATES)
    .distinct('vehicles.plate_number as plate');
  const seeded = new Set(jobRows.map((r: { plate: string }) => r.plate));
  const missingPlates = E2E_PLATES.filter((p) => !seeded.has(p));
  const publishedTemplate = (await listAssignableTemplates()).some((t) => t.name === 'E2E Checklist');
  const activeRiskPolicy = (await db('risk_matrix_versions').where({ status: 'ACTIVE' }).first()) != null;
  const evidenceSeeded = await db('jobs').join('vehicles', 'vehicles.id', 'jobs.vehicle_id').whereIn('vehicles.plate_number', EVIDENCE_PLATES).distinct('vehicles.plate_number as plate');
  const evidenceJobs = evidenceSeeded.length === EVIDENCE_PLATES.length;
  const ready = missingPlates.length === 0 && publishedTemplate && activeRiskPolicy && evidenceJobs;
  return { ready, expectedPlates: E2E_PLATES.length, seededPlates: seeded.size, missingPlates, publishedTemplate, activeRiskPolicy, evidenceJobs };
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
  await ensureSeedJobs();
  await ensureEvidenceJobs();

  // Boot self-check: refuse to start if the fixtures the browser specs depend on
  // are incomplete — a clear, early error instead of 12 opaque "job not found"
  // Playwright failures. Playwright's webServer health gate then never opens.
  const readiness = await fixtureReadiness();
  if (!readiness.ready) {
    console.error(
      `[e2e-server] FIXTURE PREFLIGHT FAILED — refusing to start. ` +
        `plates ${readiness.seededPlates}/${readiness.expectedPlates}` +
        (readiness.missingPlates.length ? ` missing=[${readiness.missingPlates.join(', ')}]` : '') +
        ` publishedTemplate=${readiness.publishedTemplate} activeRiskPolicy=${readiness.activeRiskPolicy} evidenceJobs=${readiness.evidenceJobs}. ` +
        `Is the server on the Phase 10F harness (reset-test-db + per-flow seeds)?`,
    );
    await db.destroy();
    process.exit(1);
  }

  // Preflight-first wrapper: an UNAUTHENTICATED, non-sensitive readiness endpoint
  // mounted BEFORE the real app (so it sits ahead of the app's 404), then the real
  // app handles everything else. Lets Playwright's global setup verify fixtures
  // before opening any browser.
  const wrapper = express();
  wrapper.get('/api/v1/e2e/preflight', async (_req, res) => {
    try {
      const r = await fixtureReadiness();
      res.status(r.ready ? 200 : 503).json(r);
    } catch (err) {
      res.status(500).json({ ready: false, error: err instanceof Error ? err.message : 'preflight error' });
    }
  });
  wrapper.use(createApp());

  const server = wrapper.listen(PORT, () => {
    console.log(
      `[e2e-server] API listening on http://127.0.0.1:${PORT} (DB=${process.env.DB_NAME}) — fake SMS, memory storage, policy ACTIVE; ` +
        `fixtures READY (${readiness.seededPlates}/${readiness.expectedPlates} plates, template=${readiness.publishedTemplate}, policy=${readiness.activeRiskPolicy})`,
    );
  });

  const shutdown = () => { server.close(() => db.destroy().finally(() => process.exit(0))); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[e2e-server] failed to start:', err);
  process.exit(1);
});
