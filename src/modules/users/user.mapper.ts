import { ROLE_PERMISSIONS } from '../../rbac/permissions';
import type { AuthUser, RoleCode, UserRow, UserStatus } from '../../types/auth';

export interface UserWithRole extends UserRow {
  role_code: RoleCode;
}

export interface UserWithRoleBranch extends UserWithRole {
  branch_name: string | null;
}

/** Single mapping point from a DB row to the safe authenticated-user shape. */
export function toAuthUser(row: UserWithRole): AuthUser {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    region: row.region,
    branchId: row.branch_id,
    role: row.role_code,
    status: row.status,
    avatarUrl: row.avatar_url,
    // MySQL returns tinyint(1) as 0/1 (or boolean under some drivers) — coerce.
    mustChangePassword: Boolean(row.must_change_password),
    permissions: ROLE_PERMISSIONS[row.role_code],
  };
}

/** User shape returned by the user-management API — never includes password_hash. */
export interface UserDetail {
  id: number;
  firstName: string;
  lastName: string;
  phone: string;
  region: string;
  role: RoleCode;
  branchId: number | null;
  branchName: string | null;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export function toUserDetail(row: UserWithRoleBranch): UserDetail {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    region: row.region,
    role: row.role_code,
    branchId: row.branch_id,
    branchName: row.branch_name,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}
