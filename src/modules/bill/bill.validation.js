'use strict';

const { z } = require('zod');

const monetaryAmount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'Must be a valid decimal number');

const lineItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: monetaryAmount,
  unitPrice: monetaryAmount,
  lineTotal: monetaryAmount,
});

const createBillSchema = z.object({
  supplierId: z.string().optional().nullable(),
  supplierName: z.string().min(1).max(200),
  supplierEmail: z.string().email().optional().or(z.literal('')),
  issueDate: z.string().refine((value) => !isNaN(Date.parse(value)), 'Valid date required'),
  dueDate: z.string().refine((value) => !isNaN(Date.parse(value)), 'Valid date required'),
  currency: z.string().max(10).optional().default('EGP'),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item required'),
  subtotal: monetaryAmount,
  total: monetaryAmount,
  notes: z.string().max(2000).optional().default(''),
});

const postBillSchema = z.object({
  apAccountId: z.string().min(1, 'Accounts Payable account required'),
  debitAccountId: z.string().min(1, 'Debit account required'),
});

const recordBillPaymentSchema = z.object({
  cashAccountId: z.string().min(1, 'Cash/Bank account required'),
  amount: monetaryAmount,
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
