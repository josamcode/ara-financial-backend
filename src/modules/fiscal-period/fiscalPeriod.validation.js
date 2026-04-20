'use strict';

const { z } = require('zod');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

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

const periodIdParamSchema = z.object({
  id: z.string().regex(objectIdPattern, 'Fiscal period ID must be a valid ObjectId'),
}).strict();

const listPeriodsQuerySchema = z.object({
  year: optionalInteger({ label: 'Year', min: 1900, max: 9999 }),
}).strict();

const createFiscalYearSchema = z.object({
  year: z.coerce
    .number()
    .int('Year must be an integer')
    .min(1900, 'Year must be at least 1900')
    .max(9999, 'Year must be at most 9999'),
  startMonth: optionalInteger({ label: 'Start month', min: 1, max: 12 }),
}).strict();

module.exports = {
  periodIdParamSchema,
  listPeriodsQuerySchema,
  createFiscalYearSchema,
};
