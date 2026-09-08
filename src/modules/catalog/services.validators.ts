import { z } from 'zod';
import { MAX_PRICE_MINOR } from './money';

const code = z.string().trim().min(1, 'Kod kiritilishi shart').max(60);
const name = z.string().trim().min(1, 'Nomi kiritilishi shart').max(200);
const priceMinor = z.number().int().min(0).max(MAX_PRICE_MINOR);
const currency = z.enum(['UZS']);
const priceBasis = z.enum(['NET', 'GROSS', 'UNKNOWN']);
const durationMinutes = z.number().int().min(0).max(100000);
const taxRateBp = z.number().int().min(0).max(100000); // basis points; 1200 = 12.00%
const priceReason = z.string().trim().max(500).optional();

export const listServicesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  sort: z.enum(['name', 'code', 'price', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const createServiceSchema = z.object({
  code,
  name,
  categoryId: z.number().int().positive(),
  durationMinutes: durationMinutes.nullable().optional(),
  priceMinor: priceMinor.nullable().optional(),
  currency: currency.optional(),
  priceBasis: priceBasis.optional(),
  taxRateBp: taxRateBp.nullable().optional(),
  priceInclusiveMinor: priceMinor.nullable().optional(),
  priceReason,
});

export const updateServiceSchema = z
  .object({
    version: z.number().int().min(1),
    code: code.optional(),
    name: name.optional(),
    categoryId: z.number().int().positive().optional(),
    durationMinutes: durationMinutes.nullable().optional(),
    priceMinor: priceMinor.nullable().optional(),
    currency: currency.optional(),
    priceBasis: priceBasis.optional(),
    taxRateBp: taxRateBp.nullable().optional(),
    priceInclusiveMinor: priceMinor.nullable().optional(),
    priceReason,
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'version' && k !== 'priceReason'), {
    message: "O'zgartirish uchun maydon berilmadi",
  });

export const serviceIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type ListServicesQuery = z.infer<typeof listServicesQuerySchema>;
export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
