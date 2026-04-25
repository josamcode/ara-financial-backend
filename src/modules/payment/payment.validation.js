'use strict';

const { z } = require('zod');
const { PAYMENT_PROVIDERS, PAYMENT_STATUSES } = require('./payment.model');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;
const decimalPattern = /^\d+(\.\d{1,6})?$/;
const safeReferenceTypePattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/;

const positiveDecimal = z.preprocess(
  (value) => (typeof value === 'number' ? String(value) : value),
  z
    .string({ required_error: 'amount is required' })
    .trim()
    .regex(decimalPattern, 'amount must be a valid positive decimal')
    .refine((value) => Number(value) > 0, 'amount must be greater than zero')
);

const optionalObjectId = z
  .string()
  .regex(objectIdPattern, 'referenceId must be a valid ObjectId')
  .optional()
  .nullable();

function optionalPositiveInteger(max) {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') return undefined;
      return Number(value);
    },
    z.number().int().min(1).max(max).optional()
  );
}

const idParamSchema = z.object({
  id: z.string().regex(objectIdPattern, 'id must be a valid ObjectId'),
});

const createMyFatoorahPaymentSchema = z.object({
  amount: positiveDecimal,
  currency: z.string().trim().min(1).max(10).default('EGP'),
  customerName: z.string().trim().min(1).max(200),
  customerEmail: z.string().trim().email().max(320),
  customerMobile: z.string().trim().max(50).optional().default(''),
  description: z.string().trim().max(500).optional().default(''),
  referenceType: z
    .string()
    .trim()
    .regex(safeReferenceTypePattern, 'referenceType contains invalid characters')
    .optional()
    .nullable(),
  referenceId: optionalObjectId,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const listPaymentAttemptsQuerySchema = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  provider: z.enum(PAYMENT_PROVIDERS).optional(),
  referenceType: z
    .string()
    .trim()
    .regex(safeReferenceTypePattern, 'referenceType contains invalid characters')
    .optional(),
  referenceId: optionalObjectId,
  page: optionalPositiveInteger(100000),
  limit: optionalPositiveInteger(100),
});

const myFatoorahCallbackQuerySchema = z.object({
  paymentId: z.string().trim().min(1).optional(),
  PaymentId: z.string().trim().min(1).optional(),
  Id: z.string().trim().min(1).optional(),
  id: z.string().trim().min(1).optional(),
}).passthrough();

module.exports = {
  createMyFatoorahPaymentSchema,
  listPaymentAttemptsQuerySchema,
  paymentAttemptParamsSchema: idParamSchema,
  myFatoorahCallbackQuerySchema,
};
