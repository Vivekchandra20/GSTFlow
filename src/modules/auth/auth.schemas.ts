import { z } from 'zod';

export const PasswordValidationSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters long')
  .max(128, 'Password must not exceed 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

export const RegisterBodySchema = z.object({
  email: z.string().trim().email('Invalid email address format').max(255),
  password: PasswordValidationSchema
});

export type RegisterBody = z.infer<typeof RegisterBodySchema>;

export const LoginBodySchema = z.object({
  email: z.string().trim().email('Invalid email address format').max(255),
  password: z.string().min(1, 'Password is required')
});

export type LoginBody = z.infer<typeof LoginBodySchema>;

export const RefreshBodySchema = z.object({
  refreshToken: z.string().min(20, 'Invalid refresh token format').max(256).optional()
}).optional().default({});

export type RefreshBody = z.infer<typeof RefreshBodySchema>;

export const LogoutBodySchema = z.object({
  refreshToken: z.string().min(20).max(256).optional()
}).optional().default({});

export type LogoutBody = z.infer<typeof LogoutBodySchema>;

export const SafeUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  status: z.enum(['ACTIVE', 'DISABLED']),
  emailVerified: z.boolean(),
  createdAt: z.date().or(z.string())
});

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().positive(),
  tokenType: z.literal('Bearer')
});

export const AuthResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    user: SafeUserSchema,
    tokens: AuthTokensSchema
  })
});

export const MeResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    user: SafeUserSchema
  })
});

export const LogoutResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    message: z.string()
  })
});
