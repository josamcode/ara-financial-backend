'use strict';

const { z } = require('zod');

// Use string for monetary amounts to avoid floating-point issues
const monetaryAmount = z.string().regex(
  /^\d+(\.\d{1,6})?$/,
  'Amount must be a valid decimal number (up to 6 decimal places)'
);

const journalLineSchema = z.object({
  accountId: z.string().min(1, 'Account ID is required'),
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
});

const updateJournalEntrySchema = z.object({
  date: z.string().refine((val) => !isNaN(Date.parse(val)), 'Valid date is required').optional(),
  description: z.string().min(1).max(1000).optional(),
  reference: z.string().max(200).optional(),
  lines: z
    .array(journalLineSchema)
    .min(2, 'A journal entry must have at least 2 lines')
    .optional(),
});

module.exports = { createJournalEntrySchema, updateJournalEntrySchema };
