'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');

const PERIOD_STATUSES = ['open', 'closed', 'locked'];

const fiscalPeriodSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: PERIOD_STATUSES,
      default: 'open',
    },
    year: {
      type: Number,
      required: true,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lockedAt: {
      type: Date,
      default: null,
    },
    lockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

fiscalPeriodSchema.plugin(tenantPlugin);

fiscalPeriodSchema.index({ tenantId: 1, year: 1, month: 1 }, { unique: true });
fiscalPeriodSchema.index({ tenantId: 1, startDate: 1, endDate: 1 });

const FiscalPeriod = mongoose.model('FiscalPeriod', fiscalPeriodSchema);

module.exports = { FiscalPeriod, PERIOD_STATUSES };
