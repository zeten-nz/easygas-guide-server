import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { requestMeta } from '../audit/audit.service';
import {
  createProductSchema,
  listProductsQuerySchema,
  productIdParamsSchema,
  updateProductSchema,
  type ListProductsQuery,
} from './products.validators';
import * as service from './products.service';

export const productsRouter = Router();

productsRouter.get(
  '/',
  requireAuth,
  requirePermission('catalog.view'),
  validate({ query: listProductsQuerySchema }),
  async (req: Request, res: Response) => {
    res.json(await service.listProducts(req.query as unknown as ListProductsQuery));
  },
);

productsRouter.get(
  '/:id',
  requireAuth,
  requirePermission('catalog.view'),
  validate({ params: productIdParamsSchema }),
  async (req: Request, res: Response) => {
    res.json({ product: await service.getProduct(Number(req.params.id)) });
  },
);

productsRouter.get(
  '/:id/price-history',
  requireAuth,
  requirePermission('catalog.view'),
  validate({ params: productIdParamsSchema }),
  async (req: Request, res: Response) => {
    // Ensure the product exists (404 otherwise) before returning its history.
    await service.getProduct(Number(req.params.id));
    res.json({ history: await service.getPriceHistory('product', Number(req.params.id)) });
  },
);

productsRouter.post(
  '/',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ body: createProductSchema }),
  async (req: Request, res: Response) => {
    const product = await service.createProduct(req.user!, req.body, requestMeta(req));
    res.status(201).json({ product });
  },
);

productsRouter.patch(
  '/:id',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: productIdParamsSchema, body: updateProductSchema }),
  async (req: Request, res: Response) => {
    const product = await service.updateProduct(req.user!, Number(req.params.id), req.body, requestMeta(req));
    res.json({ product });
  },
);

productsRouter.post(
  '/:id/archive',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: productIdParamsSchema }),
  async (req: Request, res: Response) => {
    const product = await service.setProductStatus(req.user!, Number(req.params.id), 'ARCHIVED', requestMeta(req));
    res.json({ product, message: 'Mahsulot arxivlandi' });
  },
);

productsRouter.post(
  '/:id/reactivate',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: productIdParamsSchema }),
  async (req: Request, res: Response) => {
    const product = await service.setProductStatus(req.user!, Number(req.params.id), 'ACTIVE', requestMeta(req));
    res.json({ product, message: 'Mahsulot faollashtirildi' });
  },
);

productsRouter.delete(
  '/:id',
  requireAuth,
  requirePermission('catalog.manage'),
  validate({ params: productIdParamsSchema }),
  async (req: Request, res: Response) => {
    const result = await service.deleteProduct(req.user!, Number(req.params.id), requestMeta(req));
    res.json({ ...result, message: "Mahsulot o'chirildi" });
  },
);
