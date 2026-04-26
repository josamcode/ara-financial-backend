'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');

const EXCHANGE_RATE_SOURCES = ['manual', 'api', 'central_bank', 'company_rate'];

const exchangeRateSchema = new mongoose.Schema(
  {
    fromCurrency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      match: [/^[A-Z]{3}$/, 'From currency must be a 3-letter ISO code'],
    },
    toCurrency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      match: [/^[A-Z]{3}$/, 'To currency must be a 3-letter ISO code'],
    },
    rate: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      validate: {
        validator(value) {
          const numeric = Number(value?.toString?.() ?? value);
          return Number.isFinite(numeric) && numeric > 0;
        },
        message: 'Exchange rate must be greater than zero',
      },
    },
    effectiveDate: {
      type: Date,
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: EXCHANGE_RATE_SOURCES,
      required: true,
      default: 'manual',
    },
    provider: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.rate = ret.rate ? ret.rate.toString() : '0';
        delete ret.__v;
        return ret;
      },
    },
  }
);

exchangeRateSchema.plugin(tenantPlugin);

exchangeRateSchema.index({ tenantId: 1, fromCurrency: 1, toCurrency: 1, effectiveDate: -1 });
exchangeRateSchema.index({ tenantId: 1, isActive: 1 });
exchangeRateSchema.index({ tenantId: 1, fromCurrency: 1, toCurrency: 1, isActive: 1 });

const ExchangeRate = mongoose.model('ExchangeRate', exchangeRateSchema);

module.exports = { ExchangeRate, EXCHANGE_RATE_SOURCES };
