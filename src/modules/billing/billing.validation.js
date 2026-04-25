'use strict';

const { z } = require('zod');
const { BILLING_CYCLES } = require('./plan.model');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

const checkoutSchema = z.object({
  planCode: z.string({ required_error: 'planCode is required' }).trim().min(1).max(100),
  billingCycle: z.enum(BILLING_CYCLES).optional(),
});

const syncPaymentParamsSchema = z.object({
  paymentAttemptId: z
    .string()
    .regex(objectIdPattern, 'paymentAttemptId must be a valid ObjectId'),
});

module.exports = {
  checkoutSchema,
  syncPaymentParamsSchema,
};
