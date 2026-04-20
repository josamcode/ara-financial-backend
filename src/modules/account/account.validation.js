'use strict';

const { z } = require('zod');

const createAccountSchema = z.object({
  code: z.string().min(1).max(20),
  nameAr: z.string().min(1).max(200),
  nameEn: z.string().min(1).max(200),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  nature: z.enum(['debit', 'credit']).optional(),
  parentId: z.string().nullable().optional(),
  isParentOnly: z.boolean().optional().default(false),
});

const updateAccountSchema = z.object({
  nameAr: z.string().min(1).max(200).optional(),
  nameEn: z.string().min(1).max(200).optional(),
  parentId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  isParentOnly: z.boolean().optional(),
});

module.exports = { createAccountSchema, updateAccountSchema };
