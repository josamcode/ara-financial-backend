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

const createInvoiceSchema = z.object({
  customerId: z.string().optional().nullable(),
  customerName: z.string().min(1).max(200),
  customerEmail: z.string().email().optional().or(z.literal('')),
  issueDate: z.string().refine((v) => !isNaN(Date.parse(v)), 'Valid date required'),
  dueDate: z.string().refine((v) => !isNaN(Date.parse(v)), 'Valid date required'),
  currency: z.string().max(10).optional().default('EGP'),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item required'),
  subtotal: monetaryAmount,
  total: monetaryAmount,
  notes: z.string().max(2000).optional().default(''),
});

const updateInvoiceSchema = z.object({
  customerId: z.string().optional().nullable(),
  customerName: z.string().min(1).max(200).optional(),
  customerEmail: z.string().email().optional().or(z.literal('')),
  issueDate: z.string().refine((v) => !isNaN(Date.parse(v)), 'Valid date required').optional(),
  dueDate: z.string().refine((v) => !isNaN(Date.parse(v)), 'Valid date required').optional(),
  currency: z.string().max(10).optional(),
  lineItems: z.array(lineItemSchema).min(1).optional(),
  subtotal: monetaryAmount.optional(),
  total: monetaryAmount.optional(),
  notes: z.string().max(2000).optional(),
});

const markSentSchema = z.object({
  arAccountId: z.string().min(1, 'Accounts Receivable account required'),
  revenueAccountId: z.string().min(1, 'Revenue account required'),
});

const recordPaymentSchema = z.object({
  cashAccountId: z.string().min(1, 'Cash/Bank account required'),
  amount: monetaryAmount,
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
