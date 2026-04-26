'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');
const softDeletePlugin = require('../../common/plugins/softDeletePlugin');

const TAX_RATE_TYPES = ['sales', 'purchase', 'both'];

const taxRateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    code: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 50,
      default: null,
      set(value) {
        if (value === undefined || value === null) return null;
        const trimmed = String(value).trim();
        return trimmed ? trimmed.toUpperCase() : null;
      },
    },
    rate: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: {
        validator(value) {
          const numeric = Number(value?.toString?.() ?? value);
          return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100;
        },
        message: 'Tax rate must be between 0 and 100',
      },
    },
    type: {
      type: String,
      required: true,
      enum: TAX_RATE_TYPES,
      default: 'both',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.rate = ret.rate ? ret.rate.toString() : '0';
        return ret;
      },
    },
  }
);

taxRateSchema.plugin(tenantPlugin);
taxRateSchema.plugin(softDeletePlugin);

taxRateSchema.index(
  { tenantId: 1, code: 1 },
  { unique: true, sparse: true, partialFilterExpression: { code: { $type: 'string' } } }
);
taxRateSchema.index({ tenantId: 1, isActive: 1 });
taxRateSchema.index({ tenantId: 1, type: 1 });

const TaxRate = mongoose.model('TaxRate', taxRateSchema);

module.exports = { TaxRate, TAX_RATE_TYPES };
