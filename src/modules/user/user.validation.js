'use strict';

const { z } = require('zod');

const inviteUserSchema = z.object({
  email: z.string().email('Valid email is required').max(254),
  name: z.string().min(2).max(150),
  roleName: z.enum(['admin', 'accountant'], {
    errorMap: () => ({ message: 'Role must be admin or accountant' }),
  }),
});

const updateRoleSchema = z.object({
  roleName: z.enum(['owner', 'admin', 'accountant'], {
    errorMap: () => ({ message: 'Invalid role name' }),
  }),
});

const updateProfileSchema = z.object({
  name: z.string().min(2).max(150).optional(),
  language: z.enum(['ar', 'en']).optional(),
});

module.exports = { inviteUserSchema, updateRoleSchema, updateProfileSchema };
