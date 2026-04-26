'use strict';

const { z } = require('zod');
const { MONEY_FACTOR, toScaledInteger } = require('../../common/utils/money');
const { EXCHANGE_RATE_SOURCES } = require('../currency/currency-snapshot');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;
const exchangeRatePattern = /^\d+(\.\d{1,12})?$/;

const monetaryAmount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'Must be a valid decimal number');

const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'Currency code must be a 3-letter ISO code')
  .transform((value) => value.toUpperCase());

const positiveExchangeRate = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return String(value);
  return value;
}, z
  .string()
  .trim()
  .regex(exchangeRatePattern, 'Exchange rate must be a valid positive decimal')
  .refine((value) => Number(value) > 0, 'Exchange rate must be greater than zero')
  .optional());

const exchangeRateDate = z
  .string()
  .trim()
  .refine((value) => !isNaN(Date.parse(value)), 'Valid date required');

const positiveMonetaryAmount = monetaryAmount.refine(
  (value) => toScaledInteger(value) > 0n,
  'Must be greater than zero'
);

const nonNegativeMonetaryAmount = monetaryAmount.refine(
  (value) => toScaledInteger(value) >= 0n,
  'Must be zero or greater'
);

const objectId = z.string().regex(objectIdPattern, 'Must be a valid ObjectId');
const requiredObjectId = (label) => z
  .string({ required_error: `${label} is required` })
  .regex(objectIdPattern, `${label} must be a valid ObjectId`);

const lineItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: positiveMonetaryAmount,
  unitPrice: nonNegativeMonetaryAmount,
  lineSubtotal: nonNegativeMonetaryAmount.optional(),
  taxRateId: z.union([objectId, z.literal('')]).optional().nullable(),
  taxRate: nonNegativeMonetaryAmount.optional(),
  taxAmount: nonNegativeMonetaryAmount.optional(),
  lineTotal: nonNegativeMonetaryAmount,
});

function toLineTotal(quantity, unitPrice) {
  return ((quantity * unitPrice) + (MONEY_FACTOR / 2n)) / MONEY_FACTOR;
}

function validateInvoiceAmounts(payload, ctx) {
  const hasTaxInputs = payload.lineItems.some((item) => (
    item.taxRateId || item.taxRate || item.taxAmount || item.lineSubtotal
  )) || payload.taxTotal;

  if (hasTaxInputs) {
    return;
  }

  let subtotalFromLines = 0n;

  payload.lineItems.forEach((item, index) => {
    const quantity = toScaledInteger(item.quantity);
    const unitPrice = toScaledInteger(item.unitPrice);
    const lineTotal = toScaledInteger(item.lineTotal);
    const expectedLineTotal = toLineTotal(quantity, unitPrice);

    if (lineTotal !== expectedLineTotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lineItems', index, 'lineTotal'],
        message: 'Line total must equal quantity x unit price',
      });
    }

    subtotalFromLines += lineTotal;
  });

  const subtotal = toScaledInteger(payload.subtotal);
  const total = toScaledInteger(payload.total);

  if (subtotal <= 0n) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subtotal'],
      message: 'Subtotal must be greater than zero',
    });
  }

  if (total <= 0n) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['total'],
      message: 'Total must be greater than zero',
    });
  }

  if (subtotal !== subtotalFromLines) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subtotal'],
      message: 'Subtotal must equal the sum of line totals',
    });
  }

  if (total !== subtotal) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['total'],
      message: 'Total must equal subtotal',
    });
  }
}

const createInvoiceSchema = z.object({
  customerId: z.union([objectId, z.literal('')]).optional().nullable(),
  customerName: z.string().min(1).max(200),
  customerEmail: z.string().email().optional().or(z.literal('')),
  issueDate: z.string().refine((v) => !isNaN(Date.parse(v)), 'Valid date required'),
  dueDate: z.string().refine((v) => !isNaN(Date.parse(v)), 'Valid date required'),
  currency: currencyCode.optional(),
  documentCurrency: currencyCode.optional(),
  exchangeRate: positiveExchangeRate,
  exchangeRateDate: exchangeRateDate.optional(),
  exchangeRateSource: z.enum(EXCHANGE_RATE_SOURCES).optional(),
  exchangeRateProvider: z.string().trim().max(100).optional().nullable(),
  isExchangeRateManualOverride: z.boolean().optional(),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item required'),
  subtotal: nonNegativeMonetaryAmount,
  taxTotal: nonNegativeMonetaryAmount.optional().default('0'),
  total: nonNegativeMonetaryAmount,
  notes: z.string().max(2000).optional().default(''),
}).superRefine(validateInvoiceAmounts);

const updateInvoiceSchema = z.object({
  customerId: z.union([objectId, z.literal('')]).optional().nullable(),
  customerName: z.string().min(1).max(200).optional(),
  customerEmail: z.string().email().optional().or(z.literal('')),
  issueDate: z.string().refine((v) => !isNaN(Date.parse(v)), 'Valid date required').optional(),
  dueDate: z.string().refine((v) => !isNaN(Date.parse(v)), 'Valid date required').optional(),
  currency: currencyCode.optional(),
  documentCurrency: currencyCode.optional(),
  exchangeRate: positiveExchangeRate,
  exchangeRateDate: exchangeRateDate.optional(),
  exchangeRateSource: z.enum(EXCHANGE_RATE_SOURCES).optional(),
  exchangeRateProvider: z.string().trim().max(100).optional().nullable(),
  isExchangeRateManualOverride: z.boolean().optional(),
  lineItems: z.array(lineItemSchema).min(1).optional(),
  subtotal: nonNegativeMonetaryAmount.optional(),
  taxTotal: nonNegativeMonetaryAmount.optional(),
  total: nonNegativeMonetaryAmount.optional(),
  notes: z.string().max(2000).optional(),
});

const markSentSchema = z.object({
  arAccountId: requiredObjectId('Accounts receivable account'),
  revenueAccountId: requiredObjectId('Revenue account'),
});

const recordPaymentSchema = z.object({
  accountId: objectId.optional(),
  cashAccountId: objectId.optional(),
  amount: positiveMonetaryAmount,
  paymentDate: z.string().refine((v) => !isNaN(Date.parse(v)), 'Valid date required').optional(),
  paymentCurrency: currencyCode.optional(),
  paymentExchangeRate: positiveExchangeRate,
  paymentExchangeRateDate: exchangeRateDate.optional(),
  paymentExchangeRateSource: z.enum(EXCHANGE_RATE_SOURCES).optional(),
  reference: z.string().trim().max(200).optional(),
}).superRefine((payload, ctx) => {
  if (!payload.accountId && !payload.cashAccountId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cashAccountId'],
      message: 'Cash or bank account is required',
    });
  }
});

const bulkInvoiceIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'At least one invoice is required'),
});

module.exports = {
  createInvoiceSchema,
  updateInvoiceSchema,
  markSentSchema,
  recordPaymentSchema,
  bulkInvoiceIdsSchema,
};
