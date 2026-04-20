'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');
const softDeletePlugin = require('../../common/plugins/softDeletePlugin');

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const ACCOUNT_NATURES = ['debit', 'credit'];

/**
 * Maps account type to its natural balance direction.
 */
const TYPE_NATURE_MAP = {
  asset: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
  expense: 'debit',
};

const accountSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      maxlength: 20,
    },
    nameAr: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    nameEn: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    type: {
      type: String,
      required: true,
      enum: ACCOUNT_TYPES,
    },
    nature: {
      type: String,
      required: true,
      enum: ACCOUNT_NATURES,
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null,
    },
    level: {
      type: Number,
      required: true,
      min: 1,
      max: 6,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isParentOnly: {
      type: Boolean,
      default: false,
    },
    systemAccount: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

accountSchema.plugin(tenantPlugin);
accountSchema.plugin(softDeletePlugin);

// Unique code per tenant
accountSchema.index({ tenantId: 1, code: 1 }, { unique: true });
accountSchema.index({ tenantId: 1, type: 1 });
accountSchema.index({ tenantId: 1, parentId: 1 });

const Account = mongoose.model('Account', accountSchema);

module.exports = { Account, ACCOUNT_TYPES, ACCOUNT_NATURES, TYPE_NATURE_MAP };
