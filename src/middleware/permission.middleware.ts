import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/errors';
import { can, type Permission } from '../rbac/permissions';

/**
 * Centralized backend authorization guard — must run after requireAuth.
 * Requires ALL listed permissions. Frontend permission checks are UX only;
 * this middleware (plus service-level policy rules) is the enforcement point.
 */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw ApiError.unauthorized();
    }
    const role = req.user.role;
    if (!permissions.every((p) => can(role, p))) {
      throw ApiError.forbidden();
    }
    next();
  };
}
