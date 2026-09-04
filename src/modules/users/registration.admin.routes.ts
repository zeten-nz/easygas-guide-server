import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import { ROLE_CODES, REGISTRATION_STATUSES } from '../../types/auth';
import * as service from './registration.admin.service';

const listQuerySchema = z.object({
  status: z.enum(REGISTRATION_STATUSES).optional(),
});

const idParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const approveSchema = z.object({
  // Admin assigns the role on approval; default is the technician role.
  roleCode: z.enum(ROLE_CODES).default('USTA'),
});

const rejectSchema = z.object({
  reason: z.string().trim().min(3, "Rad etish sababi ko'rsatilishi shart").max(500),
});

export const registrationAdminRouter = Router();

// Registration request review is centrally authorized (currently ADMIN-only via ROLE_PERMISSIONS).
registrationAdminRouter.use(requireAuth, requirePermission('registration.review'));

registrationAdminRouter.get('/', validate({ query: listQuerySchema }), async (req: Request, res: Response) => {
  const status = req.query.status as (typeof REGISTRATION_STATUSES)[number] | undefined;
  const requests = await service.listRegistrationRequests(status);
  res.json({ requests });
});

registrationAdminRouter.post(
  '/:id/approve',
  validate({ params: idParamsSchema, body: approveSchema }),
  async (req: Request, res: Response) => {
    const result = await service.approveRegistrationRequest(
      Number(req.params.id),
      req.body.roleCode,
      req.user!.id,
      requestMeta(req),
    );
    res.json({ message: "So'rov tasdiqlandi, foydalanuvchi hisobi yaratildi", userId: result.userId });
  },
);

registrationAdminRouter.post(
  '/:id/reject',
  validate({ params: idParamsSchema, body: rejectSchema }),
  async (req: Request, res: Response) => {
    await service.rejectRegistrationRequest(Number(req.params.id), req.body.reason, req.user!.id, requestMeta(req));
    res.json({ message: "So'rov rad etildi" });
  },
);
