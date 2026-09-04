import { Router } from 'express';
import type { Request, Response } from 'express';
import { optionalAuth, requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { can } from '../../rbac/permissions';
import { requestMeta } from '../audit/audit.service';
import { branchIdParamsSchema, createBranchSchema, updateBranchSchema } from './branches.validators';
import * as service from './branches.service';

export const branchesRouter = Router();

/**
 * Adaptive listing on a single endpoint:
 * - unauthenticated / unauthorized: minimal ACTIVE list (the public sign-up
 *   form needs it before authentication) — id, name, region only;
 * - callers with branches.manage: full management data, all statuses.
 * There is intentionally NO DELETE route — branches referenced by users are
 * protected by FK RESTRICT and are only ever soft-deactivated.
 */
branchesRouter.get('/', optionalAuth, async (req: Request, res: Response) => {
  if (req.user && can(req.user.role, 'branches.manage')) {
    res.json({ branches: await service.listBranchesFull(), manage: true });
    return;
  }
  res.json({ branches: await service.listBranchesPublic() });
});

branchesRouter.get(
  '/:id',
  requireAuth,
  requirePermission('branches.manage'),
  validate({ params: branchIdParamsSchema }),
  async (req: Request, res: Response) => {
    res.json({ branch: await service.getBranch(Number(req.params.id)) });
  },
);

branchesRouter.post(
  '/',
  requireAuth,
  requirePermission('branches.manage'),
  validate({ body: createBranchSchema }),
  async (req: Request, res: Response) => {
    const branch = await service.createBranch(req.user!, req.body, requestMeta(req));
    res.status(201).json({ branch });
  },
);

branchesRouter.patch(
  '/:id',
  requireAuth,
  requirePermission('branches.manage'),
  validate({ params: branchIdParamsSchema, body: updateBranchSchema }),
  async (req: Request, res: Response) => {
    const branch = await service.updateBranch(req.user!, Number(req.params.id), req.body, requestMeta(req));
    res.json({ branch });
  },
);

branchesRouter.post(
  '/:id/activate',
  requireAuth,
  requirePermission('branches.manage'),
  validate({ params: branchIdParamsSchema }),
  async (req: Request, res: Response) => {
    const branch = await service.setBranchStatus(req.user!, Number(req.params.id), 'ACTIVE', requestMeta(req));
    res.json({ branch, message: 'Filial faollashtirildi' });
  },
);

branchesRouter.post(
  '/:id/deactivate',
  requireAuth,
  requirePermission('branches.manage'),
  validate({ params: branchIdParamsSchema }),
  async (req: Request, res: Response) => {
    const branch = await service.setBranchStatus(req.user!, Number(req.params.id), 'INACTIVE', requestMeta(req));
    res.json({ branch, message: 'Filial faolsizlantirildi' });
  },
);
