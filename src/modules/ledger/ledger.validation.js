'use strict';

const { z } = require('zod');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

function isValidDate(value) {
  return !Number.isNaN(new Date(value).getTime());
}

function optionalInteger({ label, min, max }) {
  return z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : value),
    z.coerce
      .number()
      .int(`${label} must be an integer`)
      .min(min, `${label} must be at least ${min}`)
      .max(max, `${label} must be at most ${max}`)
      .optional()
  );
}

const optionalDateSchema = z.preprocess(
  (value) => (value === undefined || value === '' ? undefined : value),
  z
    .string()
    .min(1, 'Date is required')
    .refine(isValidDate, 'Valid date is required')
    .optional()
);

function validateDateOrder(data, ctx) {
  if (!data.startDate || !data.endDate) {
    return;
  }

  if (new Date(data.startDate) > new Date(data.endDate)) {
    ctx.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'End date must be on or after the start date',
    });
  }
}

const accountIdParamSchema = z.object({
  accountId: z.string().regex(objectIdPattern, 'Account ID must be a valid ObjectId'),
}).strict();

const ledgerQuerySchema = z.object({
  startDate: optionalDateSchema,
  endDate: optionalDateSchema,
  page: optionalInteger({ label: 'Page', min: 1, max: 100000 }),
  limit: optionalInteger({ label: 'Limit', min: 1, max: 100 }),
}).strict().superRefine(validateDateOrder);

const exportLedgerQuerySchema = z.object({
  startDate: optionalDateSchema,
  endDate: optionalDateSchema,
}).strict().superRefine(validateDateOrder);

module.exports = {
  accountIdParamSchema,
  ledgerQuerySchema,
  exportLedgerQuerySchema,
};
