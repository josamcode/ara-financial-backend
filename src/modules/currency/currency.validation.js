'use strict';

const { z } = require('zod');

const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'Currency code must be a 3-letter ISO code')
  .transform((value) => value.toUpperCase());

const currencyCodeParamSchema = z.object({
  code: currencyCodeSchema,
});

const booleanQuerySchema = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  return value;
}, z.boolean().optional());

const listCurrenciesQuerySchema = z.object({
  isActive: booleanQuerySchema,
}).strict();

const createCurrencySchema = z.object({
  code: currencyCodeSchema,
  name: z.string().trim().min(1).max(100),
  symbol: z.string().trim().min(1).max(20),
  decimalPlaces: z.coerce.number().int().min(0).max(6).optional().default(2),
  isActive: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false),
  sortOrder: z.coerce.number().int().optional().default(0),
}).strict();

const updateCurrencySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  symbol: z.string().trim().min(1).max(20).optional(),
  decimalPlaces: z.coerce.number().int().min(0).max(6).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
}).strict();

module.exports = {
  createCurrencySchema,
  updateCurrencySchema,
  listCurrenciesQuerySchema,
  currencyCodeParamSchema,
  currencyCodeSchema,
};
