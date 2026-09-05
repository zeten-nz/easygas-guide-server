/**
 * Phase 10D risk-policy bootstrap CLI (safe first-activation path).
 *
 *   npm run risk-policy -- list
 *   npm run risk-policy -- activate --version v1 --approver <userId> --rationale "..."
 *   npm run risk-policy -- retire --version v1 --approver <userId>
 *
 * Requires an explicit version, an approver USER whose role holds
 * `risk.matrix.approve`, and (for activate) a rationale — there is NO default
 * auto-approval. Use this to activate the first matrix when readiness is 503
 * because no policy is approved yet.
 */
import { db } from '../../config/database';
import { toAuthUser, type UserWithRole } from '../users/user.mapper';
import { can } from '../../rbac/permissions';
import * as policy from './risk-policy.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadApprover(): Promise<ReturnType<typeof toAuthUser>> {
  const id = Number(arg('approver'));
  if (!Number.isInteger(id)) throw new Error('--approver <userId> is required');
  const user = (await db('users').select('users.*', 'roles.code as role_code').join('roles', 'roles.id', 'users.role_id').where('users.id', id).whereNull('users.deleted_at').first()) as UserWithRole | undefined;
  if (!user) throw new Error(`approver user ${id} not found`);
  const authUser = toAuthUser(user);
  if (!can(authUser.role, 'risk.matrix.approve')) throw new Error(`user ${id} (${authUser.role}) lacks risk.matrix.approve`);
  return authUser;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const meta = { ip: null, userAgent: 'risk-policy-cli' };
  if (cmd === 'list') {
    // list needs an authorized reader; reuse the approver arg.
    const rows = await policy.listMatrices(await loadApprover());
    for (const r of rows) console.log(`${r.version.padEnd(10)} ${r.status.padEnd(8)} approvedBy=${r.approvedBy ?? '-'} ${r.rationale ? `rationale="${r.rationale}"` : ''}`);
  } else if (cmd === 'activate') {
    const version = arg('version');
    const rationale = arg('rationale');
    if (!version || !rationale) throw new Error('activate requires --version and --rationale');
    await policy.activateMatrix(await loadApprover(), version, rationale, meta);
    console.log(`[risk-policy] activated ${version}`);
  } else if (cmd === 'retire') {
    const version = arg('version');
    if (!version) throw new Error('retire requires --version');
    await policy.retireMatrix(await loadApprover(), version, meta);
    console.log(`[risk-policy] retired ${version}`);
  } else {
    console.error('Usage: risk-policy <list|activate|retire> --approver <id> [--version v --rationale "..."]');
    process.exitCode = 2;
  }
  await db.destroy();
}

main().catch(async (err) => {
  console.error('[risk-policy] failed:', err instanceof Error ? err.message : err);
  try { await db.destroy(); } catch { /* ignore */ }
  process.exit(1);
});
