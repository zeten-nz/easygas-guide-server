import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import {
  createUserSchema,
  listUsersQuerySchema,
  updateUserSchema,
  userIdParamsSchema,
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
