import { z } from 'zod';
import { normalizePhone } from '../../utils/phone';

const phoneSchema = z
  .string()
  .min(1, 'Telefon raqam kiritilishi shart')
  .transform((v, ctx) => {
    const normalized = normalizePhone(v);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: "Telefon raqam noto'g'ri formatda" });
      return z.NEVER;
    }
    return normalized;
  });

// loyiha.md §13: customer = ism (name) + telefon (phone) — nothing more.
const nameSchema = z.string().trim().min(2, 'Ism kamida 2 ta harfdan iborat').max(100);

export const listCustomersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const customerIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const createCustomerSchema = z.object({
  name: nameSchema,
  phone: phoneSchema,
});

export const updateCustomerSchema = z
  .object({
    name: nameSchema.optional(),
    phone: phoneSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "O'zgartirish uchun maydon berilmadi" });

export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
