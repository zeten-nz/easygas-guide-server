import { z } from 'zod';
import { normalizePhone } from '../../utils/phone';
import { ROLE_CODES } from '../../types/auth';

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

const nameSchema = (label: string) => z.string().trim().min(2, `${label} kamida 2 ta harf`).max(50);

export const listUsersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  role: z.enum(ROLE_CODES).optional(),
  branchId: z.coerce.number().int().positive().optional(),
  status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const userIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const createUserSchema = z.object({
  firstName: nameSchema('Ism'),
  lastName: nameSchema('Familiya'),
  phone: phoneSchema,
  region: z.string().trim().min(2, 'Viloyat tanlanishi shart').max(60),
  branchId: z.number().int().positive().nullable().optional(),
  roleCode: z.enum(ROLE_CODES),
  password: z.string().min(8, "Parol kamida 8 ta belgidan iborat bo'lishi kerak").max(128),
});

export const updateUserSchema = z
  .object({
    firstName: nameSchema('Ism').optional(),
    lastName: nameSchema('Familiya').optional(),
    phone: phoneSchema.optional(),
    region: z.string().trim().min(2).max(60).optional(),
    branchId: z.number().int().positive().nullable().optional(),
    roleCode: z.enum(ROLE_CODES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "O'zgartirish uchun maydon berilmadi" });

/** Admin manual password recovery: the admin re-confirms their own password and
 *  gives a mandatory reason. The NEW (temporary) password is generated server-side. */
export const resetUserPasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Joriy parolingizni kiriting').max(128),
  reason: z.string().trim().min(5, "Sabab kamida 5 ta belgidan iborat bo'lishi kerak").max(500),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ResetUserPasswordInput = z.infer<typeof resetUserPasswordSchema>;
