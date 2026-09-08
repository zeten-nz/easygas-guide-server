import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { ApiError } from '../../utils/errors';
import { requestMeta } from '../audit/audit.service';
import { isReferenceKind, type ReferenceKind } from './reference.config';
import {
  createReferenceSchema,
  listReferenceQuerySchema,
  referenceIdParamsSchema,
  referenceKindParamsSchema,
  updateReferenceSchema,
} from './reference.validators';
import * as service from './reference.service';

export const referenceRouter = Router();

/** Resolve & validate the :kind path segment (unknown kind → 404, never 500). */
function kindOf(req: Request): ReferenceKind {
  const kind = String(req.params.kind);
  if (!isReferenceKind(kind)) throw ApiError.notFound("Ma'lumotnoma turi topilmadi");
  return kind;
}

/** Wrap an async handler so thrown ApiErrors reach the error middleware. */
const h =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

referenceRouter.get(
  '/:kind',
  requireAuth,
  requirePermission('catalog.view'),
  validate({ params: referenceKindParamsSchema, query: listReferenceQuerySchema }),
  h(async (req, res) => {
    const kind = kindOf(req);
    res.json(await service.listReference(kind, req.query as unknown as service.ListReferenceQuery));
  }),
);

referenceRouter.get(
  '/:kind/:id',
  requireAuth,
  requirePermission('catalog.view'),
  validate({ params: referenceIdParamsSchema }),
  h(async (req, res) => {
    const kind = kindOf(req);
    res.json({ item: await service.getReference(kind, Number(req.params.id)) });
  }),
);

referenceRouter.post(
  '/:kind',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: referenceKindParamsSchema, body: createReferenceSchema }),
  h(async (req, res) => {
    const kind = kindOf(req);
    const item = await service.createReference(kind, req.body, req.user!, requestMeta(req));
    res.status(201).json({ item });
  }),
);

referenceRouter.patch(
  '/:kind/:id',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: referenceIdParamsSchema, body: updateReferenceSchema }),
  h(async (req, res) => {
    const kind = kindOf(req);
    const item = await service.updateReference(kind, Number(req.params.id), req.body, req.user!, requestMeta(req));
    res.json({ item });
  }),
);

referenceRouter.post(
  '/:kind/:id/archive',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: referenceIdParamsSchema }),
  h(async (req, res) => {
    const kind = kindOf(req);
    const item = await service.setReferenceStatus(kind, Number(req.params.id), 'ARCHIVED', req.user!, requestMeta(req));
    res.json({ item, message: 'Arxivlandi' });
  }),
);

referenceRouter.post(
  '/:kind/:id/reactivate',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: referenceIdParamsSchema }),
  h(async (req, res) => {
    const kind = kindOf(req);
    const item = await service.setReferenceStatus(kind, Number(req.params.id), 'ACTIVE', req.user!, requestMeta(req));
    res.json({ item, message: 'Faollashtirildi' });
  }),
);

referenceRouter.delete(
  '/:kind/:id',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: referenceIdParamsSchema }),
  h(async (req, res) => {
    const kind = kindOf(req);
    const result = await service.deleteReference(kind, Number(req.params.id), req.user!, requestMeta(req));
    res.json({ ...result, message: "O'chirildi" });
  }),
);
