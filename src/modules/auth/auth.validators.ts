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

const passwordSchema = z
  .string()
  .min(8, "Parol kamida 8 ta belgidan iborat bo'lishi kerak")
  .max(128, 'Parol juda uzun');

export const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1, 'Parol kiritilishi shart').max(128),
  rememberMe: z.boolean().optional().default(false),
});

export const registerSchema = z.object({
  firstName: z.string().trim().min(2, 'Ism kamida 2 ta harf').max(50),
  lastName: z.string().trim().min(2, 'Familiya kamida 2 ta harf').max(50),
  phone: phoneSchema,
  region: z.string().trim().min(2, 'Viloyat tanlanishi shart').max(60),
  branchId: z.coerce.number().int().positive('Servis filiali tanlanishi shart'),
  comment: z.string().trim().max(500).optional(),
  password: passwordSchema,
});

export const forgotPasswordSchema = z.object({
  phone: phoneSchema,
});

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  otp: z.string().regex(/^\d{6}$/, "Kod 6 ta raqamdan iborat bo'lishi kerak"),
});

export const resetPasswordSchema = z.object({
  resetToken: z.string().regex(/^[0-9a-f]{64}$/, "Token noto'g'ri"),
  password: passwordSchema,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
