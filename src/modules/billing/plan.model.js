'use strict';

const mongoose = require('mongoose');

const BILLING_CYCLES = ['monthly', 'yearly'];

const planSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 100,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
    price: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 10,
      default: 'SAR',
    },
    billingCycle: {
      type: String,
      enum: BILLING_CYCLES,
      required: true,
      default: 'monthly',
      index: true,
    },
    features: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    limits: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
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
        ret.price = ret.price?.toString?.() ?? ret.price;
        delete ret.__v;
        return ret;
      },
    },
  }
);

planSchema.index({ isActive: 1, sortOrder: 1, code: 1 });

const Plan = mongoose.model('Plan', planSchema);

module.exports = {
  Plan,
  BILLING_CYCLES,
};
