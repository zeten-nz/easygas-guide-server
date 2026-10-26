/**
 * Phase 10F — production release gate (machine- + human-readable).
 *   npm run release:gate            # human summary; exit 3 if BLOCKED
 *   npm run release:gate -- --json  # machine-readable result
 *
 * Evaluates LIVE checks against the connected system plus ATTESTED inputs from
 * release-attestation.json (git-ignored; template at release-attestation.example.json).
 * Production is BLOCKED unless every blocker passes. There is deliberately NO
 * escape flag that bypasses a safety blocker — the two known blockers (real
 * functional SMS provider; an ACTIVE approved risk matrix) cannot be waived here.
 *
 * Exit codes: 0 = READY, 3 = BLOCKED, 1 = evaluation error.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../src/config/database';
import { env, isProduction, validateProductionConfig, smsFeatureEnabled } from '../src/config/env';
import { smsCapability } from '../src/sms';
import { riskPolicyActive } from '../src/modules/risk/risk-policy.service';
import { readiness } from '../src/modules/health/health.service';
import { verifyAuditChains } from '../src/modules/audit/audit-verify';

interface Check {
  id: string;
  description: string;
  kind: 'live' | 'attested';
  status: 'pass' | 'fail' | 'unknown';
  detail: string;
  blocker: boolean;
}

const ATTESTED = [
  { id: 'ci_all_green', description: 'All required CI checks passed for this revision' },
  { id: 'db_migrations_verified', description: 'DB migrations verified (down/up) in CI' },
  { id: 'test_restore_succeeded', description: 'A test restore from backup succeeded' },
  { id: 'prod_npm_audit_meets_policy', description: 'Production npm audits meet policy (prod deps 0)' },
  {
    id: 'fullstack_playwright_passed',
    description:
      'COMPLETE full-stack SAFETY browser E2E passed on GitHub-hosted Actions (e2e-fullstack workflow: workflow.spec happy/blocking/reopen/assignment/GPS on desktop + Pixel 5, no skips) — the local Playwright smoke and the visual/responsive spec do NOT satisfy this',
  },
  { id: 'backup_configured_and_restore_tested', description: 'Backups configured AND restore tested' },
  { id: 'nginx_firewall_trustproxy_verified', description: 'Nginx/firewall/TRUST_PROXY_HOPS verified' },
  { id: 'production_secrets_distinct_strong', description: 'Production secrets are distinct and strong' },
  { id: 'monitoring_alerts_configured', description: 'Monitoring/alerts configured' },
  { id: 'manual_smoke_signed_off', description: 'Manual production smoke test signed off' },
];

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const checks: Check[] = [];

  // ---- LIVE blockers ----
  try {
    const pending = await db.migrate.list();
    const pendingCount = Array.isArray(pending?.[1]) ? pending[1].length : 0;
    checks.push({ id: 'migrations_applied', description: 'No pending DB migrations (migration BOOKKEEPING only — NOT a full schema verification; use db_migrations_verified for down/up in CI)', kind: 'live', blocker: true, status: pendingCount === 0 ? 'pass' : 'fail', detail: `${pendingCount} pending` });
  } catch (e) {
    checks.push({ id: 'migrations_applied', description: 'No pending DB migrations (migration BOOKKEEPING only — NOT a full schema verification; use db_migrations_verified for down/up in CI)', kind: 'live', blocker: true, status: 'unknown', detail: String((e as Error).message) });
  }

  try {
    const active = await riskPolicyActive();
    const row = active ? await db('risk_matrix_versions').where({ status: 'ACTIVE' }).first() : null;
    const approved = !!(row && row.approved_by && row.approved_at);
    checks.push({ id: 'active_approved_risk_matrix', description: 'An ACTIVE, approved risk matrix exists (KNOWN BLOCKER: v1 stays DRAFT until an EasyGas safety specialist approves)', kind: 'live', blocker: true, status: active && approved ? 'pass' : 'fail', detail: active ? (approved ? `v${row.version} active+approved` : 'active but not approved') : 'no ACTIVE matrix (fail-closed)' });
  } catch (e) {
    checks.push({ id: 'active_approved_risk_matrix', description: 'ACTIVE approved risk matrix', kind: 'live', blocker: true, status: 'unknown', detail: String((e as Error).message) });
  }

  // §E — SMS is opt-in. When no enabled feature uses it (the default after manual
  // admin recovery replaced OTP), a functional provider is NOT required and this is
  // not a blocker; when SMS is explicitly enabled the original blocker applies.
  const smsRequired = smsFeatureEnabled();
  try {
    const cap = smsCapability();
    checks.push({
      id: 'sms_provider_functional',
      description:
        'A REAL functional SMS provider is ready — required ONLY when SMS is enabled (SMS_PROVIDER=eskiz). With manual admin recovery SMS is disabled and this is not a blocker.',
      kind: 'live',
      blocker: smsRequired,
      status: smsRequired ? (cap.ready ? 'pass' : 'fail') : 'pass',
      detail: smsRequired
        ? `provider=${cap.provider} implemented=${cap.implemented} ready=${cap.ready}`
        : 'SMS disabled (manual admin recovery) — no functional provider required',
    });
  } catch (e) {
    checks.push({ id: 'sms_provider_functional', description: 'Functional SMS provider', kind: 'live', blocker: smsRequired, status: smsRequired ? 'fail' : 'pass', detail: smsRequired ? String((e as Error).message) : 'SMS disabled (manual admin recovery)' });
  }

  try {
    const v = await verifyAuditChains();
    checks.push({ id: 'audit_chain_clean', description: 'Audit hash chain is CONSISTENT (tamper-evidence links verify) — NOT a proof that no historical rows were lost (completeness is separate)', kind: 'live', blocker: true, status: v.ok ? 'pass' : 'fail', detail: v.ok ? `${v.totalChained} chained entries link OK (consistency only)` : `failures: ${v.chains.filter((c) => !c.ok).map((c) => c.chainId).join(',')}` });
  } catch (e) {
    checks.push({ id: 'audit_chain_clean', description: 'Audit chain verification', kind: 'live', blocker: true, status: 'unknown', detail: String((e as Error).message) });
  }

  try {
    const r = await readiness();
    checks.push({ id: 'readiness_ok', description: 'Readiness endpoint reports ready (db/redis/storage/riskPolicy; sms only when enabled)', kind: 'live', blocker: true, status: r.ready ? 'pass' : 'fail', detail: JSON.stringify(r.checks) });
  } catch (e) {
    checks.push({ id: 'readiness_ok', description: 'Readiness', kind: 'live', blocker: true, status: 'unknown', detail: String((e as Error).message) });
  }

  const prodProblems = validateProductionConfig(env);
  checks.push({ id: 'production_config_valid', description: 'Production configuration is valid (Redis/S3/trust-proxy/secrets/timings)', kind: 'live', blocker: true, status: isProduction ? (prodProblems.length === 0 ? 'pass' : 'fail') : 'unknown', detail: isProduction ? (prodProblems.join('; ') || 'ok') : 'not evaluated (NODE_ENV != production)' });

  // ---- ATTESTED blockers ----
  let attestation: Record<string, { attested?: boolean; by?: string; at?: string }> = {};
  // Release-evidence BINDING: the exact client/server commits + run/drill references
  // this release covers. Bounded (recorded + echoed here, never auto-filled and not a
  // verification service) so a release is traceable to specific SHAs and CI/drill runs.
  let release: Record<string, string> = {};
  let attestationFound = false;
  try {
    const doc = JSON.parse(readFileSync(resolve(__dirname, '..', 'release-attestation.json'), 'utf8'));
    attestation = doc.attestations ?? {};
    release = doc.release ?? {};
    attestationFound = true;
  } catch {
    attestationFound = false;
  }
  // Warn (do not silently pass) if the release binding is unset — evidence with no
  // SHA/run references is not traceable.
  const releaseBound = !!(release.client_sha && release.server_sha);
  for (const a of ATTESTED) {
    const rec = attestation[a.id];
    const ok = rec?.attested === true && !!rec.by && !!rec.at;
    checks.push({ id: a.id, description: a.description, kind: 'attested', blocker: true, status: ok ? 'pass' : 'fail', detail: ok ? `by ${rec!.by} at ${rec!.at}` : attestationFound ? 'not attested' : 'no release-attestation.json' });
  }

  const blocked = checks.filter((c) => c.blocker && c.status !== 'pass');
  const verdict = blocked.length === 0 ? 'READY' : 'BLOCKED';
  const result = { verdict, evaluatedAt: new Date().toISOString(), nodeEnv: env.NODE_ENV, release, releaseBound, blockers: blocked.map((c) => c.id), checks };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nPRODUCTION RELEASE GATE: ${verdict}\n`);
    console.log('Release binding (traceability, not a blocker):');
    console.log(`  client_sha=${release.client_sha || '<unset>'} server_sha=${release.server_sha || '<unset>'}`);
    console.log(`  ci_run=${release.ci_run || '<unset>'} e2e_run=${release.e2e_run || '<unset>'} restore_drill=${release.restore_drill || '<unset>'}`);
    if (!releaseBound) console.log('  WARNING: release binding is unset — this evidence is not traceable to specific commits/runs.');
    // Verification is PREFLIGHT (config/migrations/gate) + POST-START smoke against
    // the PRIVATE port BEFORE the node joins the public proxy — it never requires
    // opening public traffic to verify.
    console.log('Verification model: preflight (this gate) + post-start smoke on the PRIVATE port before public cutover.\n');
    for (const c of checks) console.log(`  [${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : '????'}] (${c.kind}) ${c.id} — ${c.detail}`);
    if (blocked.length) {
      console.log(`\nBLOCKED by ${blocked.length} unmet blocker(s): ${blocked.map((c) => c.id).join(', ')}`);
      console.log('There is no bypass for safety blockers. Resolve them (see docs/RELEASE-CHECKLIST-10F.md).');
    }
  }

  await db.destroy();
  process.exit(verdict === 'READY' ? 0 : 3);
}

main().catch(async (err) => {
  console.error('release-gate evaluation error:', err instanceof Error ? err.message : err);
  try {
    await db.destroy();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
