import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { adminResetLimiter } from '../../middleware/rate-limit.middleware';
import { requestMeta } from '../audit/audit.service';
import {
  createUserSchema,
  listUsersQuerySchema,
  updateUserSchema,
  userIdParamsSchema,
  resetUserPasswordSchema,
} from './users.validators';
import * as service from './users.service';
import type { ListUsersQuery } from './users.validators';

export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get(
  '/',
  requirePermission('users.view'),
  validate({ query: listUsersQuerySchema }),
  async (req: Request, res: Response) => {
    const result = await service.listUsers(req.user!, req.query as unknown as ListUsersQuery);
    res.json(result);
  },
);

// §C own profile — self-scoped, so it needs no users.view (every employee may view
// their OWN profile). Declared BEFORE '/:id' so 'me' is not captured as an id.
usersRouter.get('/me', async (req: Request, res: Response) => {
  const user = await service.getOwnProfile(req.user!);
  res.json({ user });
});

usersRouter.get(
  '/:id',
  requirePermission('users.view'),
  validate({ params: userIdParamsSchema }),
  async (req: Request, res: Response) => {
    const user = await service.getUser(req.user!, Number(req.params.id));
    res.json({ user });
  },
);

usersRouter.post(
  '/',
  requirePermission('users.create'),
  validate({ body: createUserSchema }),
  async (req: Request, res: Response) => {
    const user = await service.createUser(req.user!, req.body, requestMeta(req));
    res.status(201).json({ user });
  },
);

usersRouter.patch(
  '/:id',
  requirePermission('users.update'),
  validate({ params: userIdParamsSchema, body: updateUserSchema }),
  async (req: Request, res: Response) => {
    const user = await service.updateUser(req.user!, Number(req.params.id), req.body, requestMeta(req));
    res.json({ user });
  },
);

usersRouter.post(
  '/:id/block',
  requirePermission('users.block'),
  validate({ params: userIdParamsSchema }),
  async (req: Request, res: Response) => {
    const user = await service.blockUser(req.user!, Number(req.params.id), requestMeta(req));
    res.json({ user, message: 'Foydalanuvchi bloklandi, barcha sessiyalari bekor qilindi' });
  },
);

usersRouter.post(
  '/:id/unblock',
  requirePermission('users.block'),
  validate({ params: userIdParamsSchema }),
  async (req: Request, res: Response) => {
    const user = await service.unblockUser(req.user!, Number(req.params.id), requestMeta(req));
    res.json({ user, message: 'Foydalanuvchi blokdan chiqarildi' });
  },
);

// §C — ADMIN manual password recovery: issue a one-time temporary password. The
// generated password is returned ONCE in the body and never logged/cached; the
// employee must change it on first login (server-enforced). CSRF is applied
// globally under /api/v1; the admin re-confirms their own password in the body.
usersRouter.post(
  '/:id/reset-password',
  adminResetLimiter,
  requirePermission('users.reset_password'),
  validate({ params: userIdParamsSchema, body: resetUserPasswordSchema }),
  async (req: Request, res: Response) => {
    const result = await service.resetUserPassword(
      req.user!,
      Number(req.params.id),
      req.body.currentPassword,
      req.body.reason,
      requestMeta(req),
    );
    // The response carries the one-time secret — never cache it anywhere.
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      user: result.user,
      temporaryPassword: result.temporaryPassword,
      expiresAt: result.expiresAt,
      message: 'Vaqtinchalik parol yaratildi. Uni faqat tasdiqlangan xodimga shaxsan yuboring.',
    });
  },
);
