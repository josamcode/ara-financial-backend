'use strict';

const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    legalName: {
      type: String,
      trim: true,
      maxlength: 300,
    },
    taxId: {
      type: String,
      trim: true,
    },
    logoUrl: {
      type: String,
      default: null,
    },
    companyEmail: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 320,
      match: [/^\S+@\S+\.\S+$/, 'Invalid company email'],
      default: null,
    },
    companyPhone: {
      type: String,
      trim: true,
      maxlength: 50,
      default: null,
    },
    companyAddress: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    baseCurrency: {
      type: String,
      default: 'SAR',
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      match: [/^[A-Z]{3}$/, 'Base currency must be a 3-letter ISO code'],
    },
    fiscalYearStartMonth: {
      type: Number,
      default: 1, // January
      min: 1,
      max: 12,
    },
    industry: {
      type: String,
      default: 'general',
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'deleted'],
      default: 'active',
    },
    setupCompleted: {
      type: Boolean,
      default: false,
    },
    settings: {
      dateFormat: { type: String, default: 'DD/MM/YYYY' },
      numberFormat: { type: String, default: 'en-US' },
      language: { type: String, default: 'ar', enum: ['ar', 'en'] },
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Tenant model does NOT use tenantPlugin (it IS the tenant)
tenantSchema.index({ status: 1 });

const Tenant = mongoose.model('Tenant', tenantSchema);

module.exports = Tenant;
