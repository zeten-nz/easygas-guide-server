import { z } from 'zod';
import { MAX_PRICE_MINOR } from './money';

const code = z.string().trim().min(1, 'Kod kiritilishi shart').max(60);
const name = z.string().trim().min(1, 'Nomi kiritilishi shart').max(200);
const priceMinor = z.number().int('Narx butun (tiyin) qiymat bo\'lishi kerak').min(0).max(MAX_PRICE_MINOR);
const currency = z.enum(['UZS']);
const refId = z.number().int().positive();
const priceReason = z.string().trim().max(500).optional();

export const listProductsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  companyId: z.coerce.number().int().positive().optional(),
  brandId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  sort: z.enum(['name', 'code', 'price', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const createProductSchema = z.object({
  code,
  name,
  companyId: refId,
  categoryId: refId,
  brandId: refId.nullable().optional(),
  unitId: refId.nullable().optional(),
  priceMinor: priceMinor.nullable().optional(),
  currency: currency.optional(),
  priceReason,
});

export const updateProductSchema = z
  .object({
    version: z.number().int().min(1),
    code: code.optional(),
    name: name.optional(),
    companyId: refId.optional(),
    categoryId: refId.optional(),
    brandId: refId.nullable().optional(),
    unitId: refId.nullable().optional(),
    priceMinor: priceMinor.nullable().optional(),
    currency: currency.optional(),
    priceReason,
  })
  .refine(
    (v) => Object.keys(v).some((k) => k !== 'version' && k !== 'priceReason'),
    { message: "O'zgartirish uchun maydon berilmadi" },
  );

export const productIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
