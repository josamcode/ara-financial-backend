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
  lineTotal: nonNegativeMonetaryAmount,
});

function toLineTotal(quantity, unitPrice) {
  return ((quantity * unitPrice) + (MONEY_FACTOR / 2n)) / MONEY_FACTOR;
}

function validateBillAmounts(payload, ctx) {
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

const createBillSchema = z.object({
  supplierId: z.union([objectId, z.literal('')]).optional().nullable(),
  supplierName: z.string().min(1).max(200),
  supplierEmail: z.string().email().optional().or(z.literal('')),
  issueDate: z.string().refine((value) => !isNaN(Date.parse(value)), 'Valid date required'),
  dueDate: z.string().refine((value) => !isNaN(Date.parse(value)), 'Valid date required'),
  currency: z.string().max(10).optional().default('EGP'),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item required'),
  subtotal: nonNegativeMonetaryAmount,
  total: nonNegativeMonetaryAmount,
  notes: z.string().max(2000).optional().default(''),
}).superRefine(validateBillAmounts);

const postBillSchema = z.object({
  apAccountId: requiredObjectId('Accounts payable account'),
  debitAccountId: requiredObjectId('Debit account'),
});

const recordBillPaymentSchema = z.object({
  cashAccountId: requiredObjectId('Cash or bank account'),
  amount: positiveMonetaryAmount,
  paymentDate: z.string().refine((value) => !isNaN(Date.parse(value)), 'Valid date required').optional(),
});

const bulkBillIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'At least one bill is required'),
});

module.exports = {
  createBillSchema,
  postBillSchema,
  recordBillPaymentSchema,
  bulkBillIdsSchema,
};
