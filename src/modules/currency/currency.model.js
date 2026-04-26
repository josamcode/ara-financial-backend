'use strict';

const mongoose = require('mongoose');

const currencySchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      match: [/^[A-Z]{3}$/, 'Currency code must be a 3-letter ISO code'],
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    symbol: {
      type: String,
      required: true,
      trim: true,
      maxlength: 20,
    },
    decimalPlaces: {
      type: Number,
      required: true,
      default: 2,
      min: 0,
      max: 6,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

currencySchema.index({ code: 1 }, { unique: true });
currencySchema.index({ isActive: 1, sortOrder: 1, code: 1 });

const Currency = mongoose.model('Currency', currencySchema);

module.exports = { Currency };
