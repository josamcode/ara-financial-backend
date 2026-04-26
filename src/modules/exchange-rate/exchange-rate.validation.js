'use strict';

const { z } = require('zod');
const { EXCHANGE_RATE_SOURCES } = require('./exchange-rate.model');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;
const exchangeRatePattern = /^\d+(\.\d{1,12})?$/;

const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'Currency code must be a 3-letter ISO code')
  .transform((value) => value.toUpperCase());

const positiveRateSchema = z
  .string()
  .trim()
  .regex(exchangeRatePattern, 'Rate must be a valid positive decimal')
  .refine((value) => Number(value) > 0, 'Rate must be greater than zero');

const dateSchema = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Valid date required');

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

function optionalPositiveInteger(max) {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') return undefined;
      return Number(value);
    },
    z.number().int().min(1).max(max).optional()
  );
}

const exchangeRateIdParamSchema = z.object({
  id: z.string().regex(objectIdPattern, 'Exchange rate ID must be a valid ObjectId'),
});

const createExchangeRateSchema = z.object({
  fromCurrency: currencyCodeSchema,
  toCurrency: currencyCodeSchema,
  rate: positiveRateSchema,
  effectiveDate: dateSchema,
  source: z.enum(EXCHANGE_RATE_SOURCES).optional().default('manual'),
  provider: z.string().trim().max(100).optional().nullable(),
  isActive: z.boolean().optional().default(true),
  notes: z.string().trim().max(1000).optional().default(''),
}).strict();

const updateExchangeRateSchema = z.object({
  fromCurrency: currencyCodeSchema.optional(),
  toCurrency: currencyCodeSchema.optional(),
  rate: positiveRateSchema.optional(),
  effectiveDate: dateSchema.optional(),
  source: z.enum(EXCHANGE_RATE_SOURCES).optional(),
  provider: z.string().trim().max(100).optional().nullable(),
  isActive: z.boolean().optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

const latestExchangeRateQuerySchema = z.object({
  from: currencyCodeSchema,
  to: currencyCodeSchema,
  date: dateSchema.optional(),
}).strict();

const listExchangeRatesQuerySchema = z.object({
  from: currencyCodeSchema.optional(),
  to: currencyCodeSchema.optional(),
  source: z.enum(EXCHANGE_RATE_SOURCES).optional(),
  isActive: booleanQuerySchema,
  page: optionalPositiveInteger(100000),
  limit: optionalPositiveInteger(100),
}).strict();

module.exports = {
  createExchangeRateSchema,
  updateExchangeRateSchema,
  latestExchangeRateQuerySchema,
  listExchangeRatesQuerySchema,
  exchangeRateIdParamSchema,
};
