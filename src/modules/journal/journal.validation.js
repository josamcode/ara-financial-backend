'use strict';

const { z } = require('zod');
const { getJournalLinesValidationMessage } = require('./journal.invariants');

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

// Use string for monetary amounts to avoid floating-point issues
const monetaryAmount = z.string().regex(
  /^\d+(\.\d{1,6})?$/,
  'Amount must be a valid decimal number (up to 6 decimal places)'
);

const requiredObjectId = (label) => z
  .string({ required_error: `${label} is required` })
  .regex(objectIdPattern, `${label} must be a valid ObjectId`);

const journalLineSchema = z.object({
  accountId: requiredObjectId('Account ID'),
  debit: monetaryAmount.optional().default('0'),
  credit: monetaryAmount.optional().default('0'),
  description: z.string().max(500).optional().default(''),
});

const createJournalEntrySchema = z.object({
  date: z.string().refine((val) => !isNaN(Date.parse(val)), 'Valid date is required'),
  description: z.string().min(1).max(1000),
  reference: z.string().max(200).optional().default(''),
  lines: z
    .array(journalLineSchema)
    .min(2, 'A journal entry must have at least 2 lines'),
}).superRefine((payload, ctx) => {
  const message = getJournalLinesValidationMessage(payload.lines);
  if (message) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lines'],
      message,
    });
  }
});

const updateJournalEntrySchema = z.object({
  date: z.string().refine((val) => !isNaN(Date.parse(val)), 'Valid date is required').optional(),
  description: z.string().min(1).max(1000).optional(),
  reference: z.string().max(200).optional(),
  lines: z
    .array(journalLineSchema)
    .min(2, 'A journal entry must have at least 2 lines')
    .optional(),
}).superRefine((payload, ctx) => {
  if (!payload.lines) {
    return;
  }

  const message = getJournalLinesValidationMessage(payload.lines);
  if (message) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lines'],
      message,
    });
  }
});

module.exports = { createJournalEntrySchema, updateJournalEntrySchema };
