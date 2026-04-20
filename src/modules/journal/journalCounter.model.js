'use strict';

const mongoose = require('mongoose');

const journalCounterSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      default: 'journal_entry',
      trim: true,
    },
    sequence: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

journalCounterSchema.index({ tenantId: 1, key: 1 }, { unique: true });

const JournalCounter = mongoose.model('JournalCounter', journalCounterSchema);

module.exports = JournalCounter;
