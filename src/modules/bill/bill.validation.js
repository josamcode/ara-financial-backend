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

module.exports = {
  createBillSchema,
};
