'use strict';

const { z } = require('zod');

const baseCurrencySchema = z.object({
  baseCurrency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'Base currency must be a 3-letter ISO code')
    .transform((value) => value.toUpperCase()),
}).strict();

module.exports = {
  baseCurrencySchema,
};
