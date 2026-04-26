'use strict';

const { z } = require('zod');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

const taxRateAmount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'Rate must be a valid decimal number')
  .refine((value) => Number(value) >= 0 && Number(value) <= 100, {
    message: 'Rate must be between 0 and 100',
  });

const taxRateType = z.enum(['sales', 'purchase', 'both']);

const idParamSchema = z.object({
  id: z.string().regex(objectIdPattern, 'Tax rate ID must be a valid ObjectId'),
});

const listTaxRatesQuerySchema = z.object({
  type: taxRateType.optional(),
  isActive: z.enum(['true', 'false']).optional(),
  page: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  search: z.string().max(200).optional(),
}).strict();

const createTaxRateSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(50).optional().nullable(),
  rate: taxRateAmount,
  type: taxRateType.default('both'),
  isActive: z.boolean().optional().default(true),
  description: z.string().max(1000).optional().default(''),
});

const updateTaxRateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(50).optional().nullable(),
  rate: taxRateAmount.optional(),
  type: taxRateType.optional(),
  isActive: z.boolean().optional(),
  description: z.string().max(1000).optional(),
}).strict();

module.exports = {
  createTaxRateSchema,
  updateTaxRateSchema,
  listTaxRatesQuerySchema,
  idParamSchema,
};
