export const ROLE_CODES = ['USTA', 'MASTER', 'RAHBAR', 'SIFAT', 'ADMIN'] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export const USER_STATUSES = ['ACTIVE', 'BLOCKED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const REGISTRATION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export interface UserRow {
  id: number;
  first_name: string;
  last_name: string;
  phone: string;
  password_hash: string;
  avatar_url: string | null;
  region: string;
  branch_id: number | null;
  role_id: number;
  status: UserStatus;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
  deleted_at: Date | null;
}

export interface RoleRow {
  id: number;
  code: RoleCode;
  name: string;
}

export interface BranchRow {
  id: number;
  name: string;
  region: string;
  address: string | null;
  phone: string | null;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface SessionRow {
  id: string;
  user_id: number;
  token_hash: string;
  remember_me: number;
  /** Absolute-lifetime cap (Phase 10C). Kept named expires_at for compatibility. */
  expires_at: Date;
  created_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
  ip: string | null;
  user_agent: string | null;
  // --- Phase 10C session lifecycle ---
  absolute_expires_at: Date;
  /** All rotations of one login share a family id; replay revokes the family. */
  family_id: string;
  /** Successor session id once this token has been rotated out. */
  rotated_to_id: string | null;
  /** When this token was rotated out (start of the concurrency grace window). */
  superseded_at: Date | null;
  /** Monotonic per-family rotation counter — drives client CSRF ordering. */
  rotation_seq: number;
}

export interface RegistrationRequestRow {
  id: number;
  first_name: string;
  last_name: string;
  phone: string;
  region: string;
  branch_id: number;
  comment: string | null;
  password_hash: string;
  status: RegistrationStatus;
  reviewed_by: number | null;
  reviewed_at: Date | null;
  reject_reason: string | null;
  created_user_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface PasswordResetRow {
  id: number;
  user_id: number;
  phone: string;
  otp_hash: string;
  otp_expires_at: Date;
  attempts: number;
  consumed_at: Date | null;
  reset_token_hash: string | null;
  reset_token_expires_at: Date | null;
  reset_used_at: Date | null;
  request_ip: string | null;
  created_at: Date;
}

import type { Permission } from '../rbac/permissions';

/** Authenticated user attached to req.user — never includes password_hash. */
export interface AuthUser {
  id: number;
  firstName: string;
  lastName: string;
  phone: string;
  region: string;
  branchId: number | null;
  role: RoleCode;
  status: UserStatus;
  avatarUrl: string | null;
  /** Derived from ROLE_PERMISSIONS — sent to the client for UX-only checks. */
  permissions: readonly Permission[];
}
