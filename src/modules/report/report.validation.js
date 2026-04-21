'use strict';

const { z } = require('zod');

function isValidDate(value) {
  return !Number.isNaN(new Date(value).getTime());
}

const isoDateSchema = z
  .string()
  .min(1, 'Date is required')
  .refine(isValidDate, 'Valid date is required');

const refreshSchema = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  return value;
}, z.boolean().optional().default(false));

const exportFormatSchema = z.enum(['csv', 'excel', 'pdf']).optional().default('csv');

function validateDateOrder(data, ctx, startKey, endKey, messagePrefix) {
  const start = data[startKey];
  const end = data[endKey];

  if (!start || !end) {
    return;
  }

  if (new Date(start) > new Date(end)) {
    ctx.addIssue({
      code: 'custom',
      path: [endKey],
      message: `${messagePrefix} end date must be on or after the start date`,
    });
  }
}

function requireComparisonRange(data, ctx) {
  const hasCompareStart = Boolean(data.compareStartDate);
  const hasCompareEnd = Boolean(data.compareEndDate);

  if (hasCompareStart !== hasCompareEnd) {
    ctx.addIssue({
      code: 'custom',
      path: ['compareStartDate'],
      message: 'Comparison start date and end date must both be provided',
    });
  }
}

const trialBalanceQuerySchema = z.object({
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  compareStartDate: isoDateSchema.optional(),
  compareEndDate: isoDateSchema.optional(),
  refresh: refreshSchema,
}).strict().superRefine((data, ctx) => {
  validateDateOrder(data, ctx, 'startDate', 'endDate', 'Report');
  requireComparisonRange(data, ctx);
  validateDateOrder(data, ctx, 'compareStartDate', 'compareEndDate', 'Comparison');
});

const incomeStatementQuerySchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  compareStartDate: isoDateSchema.optional(),
  compareEndDate: isoDateSchema.optional(),
  refresh: refreshSchema,
}).strict().superRefine((data, ctx) => {
  validateDateOrder(data, ctx, 'startDate', 'endDate', 'Report');
  requireComparisonRange(data, ctx);
  validateDateOrder(data, ctx, 'compareStartDate', 'compareEndDate', 'Comparison');
});

const balanceSheetQuerySchema = z.object({
  asOfDate: isoDateSchema,
  compareAsOfDate: isoDateSchema.optional(),
  refresh: refreshSchema,
}).strict();

const cashFlowQuerySchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  compareStartDate: isoDateSchema.optional(),
  compareEndDate: isoDateSchema.optional(),
  refresh: refreshSchema,
}).strict().superRefine((data, ctx) => {
  validateDateOrder(data, ctx, 'startDate', 'endDate', 'Report');
  requireComparisonRange(data, ctx);
  validateDateOrder(data, ctx, 'compareStartDate', 'compareEndDate', 'Comparison');
});

const arAgingQuerySchema = z.object({
  asOfDate: isoDateSchema.optional(),
  refresh: refreshSchema,
}).strict();

const apAgingQuerySchema = z.object({
  asOfDate: isoDateSchema.optional(),
  refresh: refreshSchema,
}).strict();

const trialBalanceExportQuerySchema = trialBalanceQuerySchema.extend({
  format: exportFormatSchema,
}).strict();

const incomeStatementExportQuerySchema = incomeStatementQuerySchema.extend({
  format: exportFormatSchema,
}).strict();

const balanceSheetExportQuerySchema = balanceSheetQuerySchema.extend({
  format: exportFormatSchema,
}).strict();

const cashFlowExportQuerySchema = cashFlowQuerySchema.extend({
  format: exportFormatSchema,
}).strict();

module.exports = {
  trialBalanceQuerySchema,
  incomeStatementQuerySchema,
  balanceSheetQuerySchema,
  cashFlowQuerySchema,
  arAgingQuerySchema,
  apAgingQuerySchema,
  trialBalanceExportQuerySchema,
  incomeStatementExportQuerySchema,
  balanceSheetExportQuerySchema,
  cashFlowExportQuerySchema,
};
