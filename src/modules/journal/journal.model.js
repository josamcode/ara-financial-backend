'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');
const softDeletePlugin = require('../../common/plugins/softDeletePlugin');
const { getJournalLinesValidationMessage } = require('./journal.invariants');

const ENTRY_STATUSES = ['draft', 'posted'];

/**
 * Journal Line sub-document schema.
 * Embedded within JournalEntry for atomic operations.
 * 
 * DESIGN DECISION: Lines are embedded (not a separate collection) because:
 * 1. Document-level atomicity in MongoDB guarantees the entire entry
 *    (header + lines) is saved or not — no partial/unbalanced entries.
 * 2. Reading an entry always returns complete with its lines.
 * 3. For reporting/aggregation, MongoDB's $unwind operator flattens
 *    embedded arrays efficiently in aggregation pipelines.
 */
const journalLineSchema = new mongoose.Schema(
  {
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },
    debit: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
    credit: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    lineOrder: {
      type: Number,
      required: true,
    },
  },
  {
    _id: true,
  }
);

const journalEntrySchema = new mongoose.Schema(
  {
    entryNumber: {
      type: Number,
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    reference: {
      type: String,
      trim: true,
      maxlength: 200,
      default: '',
    },
    status: {
      type: String,
      enum: ENTRY_STATUSES,
      default: 'draft',
    },
    lines: {
      type: [journalLineSchema],
      validate: {
        validator(lines) {
          return !getJournalLinesValidationMessage(lines);
        },
        message(props) {
          return getJournalLinesValidationMessage(props.value);
        },
      },
    },
    fiscalPeriodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FiscalPeriod',
      default: null,
    },
    postedAt: {
      type: Date,
      default: null,
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reversedEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    reversalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    isReversing: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        // Convert Decimal128 to string for JSON serialization
        if (ret.lines) {
          ret.lines = ret.lines.map((line) => ({
            ...line,
            debit: line.debit ? line.debit.toString() : '0',
            credit: line.credit ? line.credit.toString() : '0',
          }));
        }
        return ret;
      },
    },
  }
);

journalEntrySchema.plugin(tenantPlugin);
journalEntrySchema.plugin(softDeletePlugin);

// Unique entry number per tenant
journalEntrySchema.index({ tenantId: 1, entryNumber: 1 }, { unique: true });
journalEntrySchema.index({ tenantId: 1, date: -1 });
journalEntrySchema.index({ tenantId: 1, status: 1 });
journalEntrySchema.index({ tenantId: 1, fiscalPeriodId: 1 });
journalEntrySchema.index({ tenantId: 1, 'lines.accountId': 1 });
journalEntrySchema.index({ tenantId: 1, createdBy: 1 });
journalEntrySchema.index({ tenantId: 1, reversalEntryId: 1 });

const JournalEntry = mongoose.model('JournalEntry', journalEntrySchema);

module.exports = { JournalEntry, ENTRY_STATUSES };
