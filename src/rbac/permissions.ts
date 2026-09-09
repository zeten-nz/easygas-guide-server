import { ROLE_CODES, type RoleCode } from '../types/auth';

/**
 * Centralized RBAC registry — the single source of truth for
 * "can this user perform this action?".
 *
 * Route guards use requirePermission('...') (src/middleware/permission.middleware.ts);
 * business services use can()/policy helpers below. Roles are never compared
 * inline in controllers.
 *
 * Permissions for future phases (jobs, STOP, 5 WHY, templates) are registered
 * here already so later phases only add routes — not a new authorization model.
 * The map is code-defined for now; if Admin-editable permissions are needed
 * later, this module keeps the same API and reads from the DB instead.
 */
export const PERMISSIONS = [
  // Phase 2 — user & branch management
  'users.view',
  'users.create',
  'users.update',
  'users.block',
  'users.assign_role',
  'users.reset_password', // ADMIN-only: issue a one-time temporary password (manual recovery)
  'branches.manage',
  'registration.review',

  // Phase 3 — customers & vehicles (global registry — see rationale below)
  'customers.view',
  'customers.manage',
  'vehicles.view',
  'vehicles.manage',

  // Phase 4 — jobs (branch-scoped; scope policy in jobsBranchScope below)
  'jobs.view',
  'jobs.create',

  // Phase 5 — checklist execution (USTA/MASTER — the roles that perform jobs)
  'checklist.execute',

  // Registered for later phases (no routes yet — see loyiha.md §4 permission matrix)
  'jobs.close',
  'jobs.reopen',
  'stops.approve',
  'services.view_all',
  'five_why.create',
  'templates.manage',

  // Phase 10D — safety domain
  'risks.create', // technicians raise risks while performing work
  'risks.resolve', // supervisory: resolve/revise a risk with evidence
  'risks.override', // authorized override of a blocking risk (reason required)
  'risk.matrix.approve', // create/activate/retire a risk-matrix version (safety governance)
  'jobs.assign', // assign/reassign the responsible technician
  'gps.override', // authorized override when GPS capture is unavailable

  // Phase 11B — product & service catalogue + reference data
  'catalog.view', // read the price base + reference data (office/management roles)
  'catalog.manage', // ADMIN-only: create/edit/price/archive/delete catalogue + reference data
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Customers/vehicles form a GLOBAL registry, not branch-scoped data:
 * loyiha.md §13 requires finding an "existing vehicle" by plate/VIN no matter
 * which branch first registered it (branch scoping would force cross-branch
 * duplicate vehicles, which the spec forbids), and §11 attaches branches to
 * users and jobs only. Branch scoping applies to JOBS in a later phase.
 * Roles that open jobs (USTA, MASTER) may create/update; supervisory roles read.
 */
export const ROLE_PERMISSIONS: Record<RoleCode, readonly Permission[]> = {
  USTA: [
    'jobs.view',
    'jobs.create',
    'checklist.execute',
    'customers.view',
    'customers.manage',
    'vehicles.view',
    'vehicles.manage',
    'risks.create',
  ],
  MASTER: [
    'jobs.view',
    'jobs.create',
    'checklist.execute',
    'stops.approve',
    'jobs.close',
    'five_why.create',
    'customers.view',
    'customers.manage',
    'vehicles.view',
    'vehicles.manage',
    'risks.create',
    'risks.resolve',
    'jobs.assign', // service master assigns/reassigns technicians
    'gps.override',
  ],
  RAHBAR: ['jobs.view', 'five_why.create', 'users.view', 'users.create', 'customers.view', 'vehicles.view', 'catalog.view'],
  SIFAT: [
    'jobs.view',
    'jobs.reopen',
    'services.view_all',
    'five_why.create',
    'customers.view',
    'vehicles.view',
    'risks.resolve',
    'risks.override',
    'risk.matrix.approve',
    'gps.override',
    'catalog.view',
  ],
  ADMIN: [
    'users.view',
    'users.create',
    'users.update',
    'users.block',
    'users.assign_role',
    'users.reset_password',
    'branches.manage',
    'registration.review',
    'customers.view',
    'customers.manage',
    'vehicles.view',
    'vehicles.manage',
    'jobs.view',
    'jobs.reopen',
    'services.view_all',
    'five_why.create',
    'templates.manage',
    'risks.resolve',
    'risks.override',
    'risk.matrix.approve',
    'jobs.assign',
    'gps.override',
    'catalog.view',
    'catalog.manage',
  ],
};

export function can(role: RoleCode, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

// ---------------------------------------------------------------------------
// Policy helpers — centralized business scoping rules for Phase 2
// ---------------------------------------------------------------------------

/**
 * Which roles an actor may assign when creating a user or changing a role.
 * ADMIN: any role. RAHBAR: only technicians/masters for their own branch
 * (loyiha.md §4 — Rahbar is branch-scoped, never a global administrator).
 * Escalation to ADMIN/SIFAT/RAHBAR always requires an ADMIN actor.
 */
export function getAssignableRoles(actorRole: RoleCode): readonly RoleCode[] {
  if (actorRole === 'ADMIN') return ROLE_CODES;
  if (actorRole === 'RAHBAR') return ['USTA', 'MASTER'];
  return [];
}

/** Roles that must belong to a branch. SIFAT/ADMIN are cross-branch (nullable). */
export const BRANCH_REQUIRED_ROLES: readonly RoleCode[] = ['USTA', 'MASTER', 'RAHBAR'];

/**
 * True when the actor's user-management scope is limited to their own branch
 * (RAHBAR). ADMIN sees every branch.
 */
export function isBranchScoped(actorRole: RoleCode): boolean {
  return actorRole !== 'ADMIN';
}

/**
 * Branch scope for JOBS per loyiha.md §11:
 * USTA/MASTER/RAHBAR → own branch only; SIFAT/ADMIN (services.view_all) → all.
 * Returns null for all-branch access, otherwise the branch id the actor is
 * confined to (-1 when the actor has no branch — matches nothing).
 */
export function jobsBranchScope(actor: { role: RoleCode; branchId: number | null }): number | null {
  if (can(actor.role, 'services.view_all')) return null;
  return actor.branchId ?? -1;
}
