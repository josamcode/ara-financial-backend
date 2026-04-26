'use strict';

const { z } = require('zod');
const { MONEY_FACTOR, toScaledInteger } = require('../../common/utils/money');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

const monetaryAmount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'Must be a valid decimal number');

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
  currency: z.string().max(10).optional().default('EGP'),
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
  currency: z.string().max(10).optional(),
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
  cashAccountId: requiredObjectId('Cash or bank account'),
  amount: positiveMonetaryAmount,
  paymentDate: z.string().refine((v) => !isNaN(Date.parse(v)), 'Valid date required').optional(),
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
