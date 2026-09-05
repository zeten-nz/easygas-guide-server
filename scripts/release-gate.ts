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
import { env, isProduction, validateProductionConfig } from '../src/config/env';
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
  { id: 'fullstack_playwright_passed', description: 'Full-stack Playwright E2E passed' },
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
    checks.push({ id: 'migrations_applied', description: 'No pending DB migrations', kind: 'live', blocker: true, status: pendingCount === 0 ? 'pass' : 'fail', detail: `${pendingCount} pending` });
  } catch (e) {
    checks.push({ id: 'migrations_applied', description: 'No pending DB migrations', kind: 'live', blocker: true, status: 'unknown', detail: String((e as Error).message) });
  }

  try {
    const active = await riskPolicyActive();
    const row = active ? await db('risk_matrix_versions').where({ status: 'ACTIVE' }).first() : null;
    const approved = !!(row && row.approved_by && row.approved_at);
    checks.push({ id: 'active_approved_risk_matrix', description: 'An ACTIVE, approved risk matrix exists (KNOWN BLOCKER: v1 stays DRAFT until an EasyGas safety specialist approves)', kind: 'live', blocker: true, status: active && approved ? 'pass' : 'fail', detail: active ? (approved ? `v${row.version} active+approved` : 'active but not approved') : 'no ACTIVE matrix (fail-closed)' });
  } catch (e) {
    checks.push({ id: 'active_approved_risk_matrix', description: 'ACTIVE approved risk matrix', kind: 'live', blocker: true, status: 'unknown', detail: String((e as Error).message) });
  }

  try {
    const cap = smsCapability();
    checks.push({ id: 'sms_provider_functional', description: 'A REAL functional SMS provider is ready (KNOWN BLOCKER: Eskiz adapter is a fail-closed stub until a verified spec exists)', kind: 'live', blocker: true, status: cap.ready ? 'pass' : 'fail', detail: `provider=${cap.provider} implemented=${cap.implemented} ready=${cap.ready}` });
  } catch (e) {
    checks.push({ id: 'sms_provider_functional', description: 'Functional SMS provider', kind: 'live', blocker: true, status: 'fail', detail: String((e as Error).message) });
  }

  try {
    const v = await verifyAuditChains();
    checks.push({ id: 'audit_chain_clean', description: 'Audit hash chain verifies clean', kind: 'live', blocker: true, status: v.ok ? 'pass' : 'fail', detail: v.ok ? `${v.totalChained} chained entries OK` : `failures: ${v.chains.filter((c) => !c.ok).map((c) => c.chainId).join(',')}` });
  } catch (e) {
    checks.push({ id: 'audit_chain_clean', description: 'Audit chain verification', kind: 'live', blocker: true, status: 'unknown', detail: String((e as Error).message) });
  }

  try {
    const r = await readiness();
    checks.push({ id: 'readiness_ok', description: 'Readiness endpoint reports ready (db/redis/storage/sms/riskPolicy)', kind: 'live', blocker: true, status: r.ready ? 'pass' : 'fail', detail: JSON.stringify(r.checks) });
  } catch (e) {
    checks.push({ id: 'readiness_ok', description: 'Readiness', kind: 'live', blocker: true, status: 'unknown', detail: String((e as Error).message) });
  }

  const prodProblems = validateProductionConfig(env);
  checks.push({ id: 'production_config_valid', description: 'Production configuration is valid (Redis/S3/trust-proxy/secrets/timings)', kind: 'live', blocker: true, status: isProduction ? (prodProblems.length === 0 ? 'pass' : 'fail') : 'unknown', detail: isProduction ? (prodProblems.join('; ') || 'ok') : 'not evaluated (NODE_ENV != production)' });

  // ---- ATTESTED blockers ----
  let attestation: Record<string, { attested?: boolean; by?: string; at?: string }> = {};
  let attestationFound = false;
  try {
    attestation = JSON.parse(readFileSync(resolve(__dirname, '..', 'release-attestation.json'), 'utf8')).attestations ?? {};
    attestationFound = true;
  } catch {
    attestationFound = false;
  }
  for (const a of ATTESTED) {
    const rec = attestation[a.id];
    const ok = rec?.attested === true && !!rec.by && !!rec.at;
    checks.push({ id: a.id, description: a.description, kind: 'attested', blocker: true, status: ok ? 'pass' : 'fail', detail: ok ? `by ${rec!.by} at ${rec!.at}` : attestationFound ? 'not attested' : 'no release-attestation.json' });
  }

  const blocked = checks.filter((c) => c.blocker && c.status !== 'pass');
  const verdict = blocked.length === 0 ? 'READY' : 'BLOCKED';
  const result = { verdict, evaluatedAt: new Date().toISOString(), nodeEnv: env.NODE_ENV, blockers: blocked.map((c) => c.id), checks };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nPRODUCTION RELEASE GATE: ${verdict}\n`);
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
