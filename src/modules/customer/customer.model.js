'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');
const softDeletePlugin = require('../../common/plugins/softDeletePlugin');

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, maxlength: 50, default: '' },
    address: { type: String, trim: true, maxlength: 500, default: '' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
  },
  { timestamps: true }
);

customerSchema.plugin(tenantPlugin);
customerSchema.plugin(softDeletePlugin);

customerSchema.index({ tenantId: 1, name: 1 });
customerSchema.index({ tenantId: 1, email: 1 });

const Customer = mongoose.model('Customer', customerSchema);

module.exports = { Customer };
