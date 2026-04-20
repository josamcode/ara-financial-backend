'use strict';

const { z } = require('zod');

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

const registerSchema = z.object({
  email: z.string().email('Valid email is required').max(254),
  password: passwordSchema,
  name: z.string().min(2, 'Name must be at least 2 characters').max(150),
  companyName: z.string().min(2, 'Company name is required').max(200),
  language: z.enum(['ar', 'en']).optional().default('ar'),
});

const loginSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(1, 'Password is required'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token must be a non-empty string').optional(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email('Valid email is required'),
});

const acceptInviteSchema = z.object({
  token: z.string().min(1, 'Invitation token is required'),
  password: passwordSchema,
  name: z.string().min(2, 'Name must be at least 2 characters').max(150).optional(),
  language: z.enum(['ar', 'en']).optional(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: passwordSchema,
});

module.exports = {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  acceptInviteSchema,
  resetPasswordSchema,
};
