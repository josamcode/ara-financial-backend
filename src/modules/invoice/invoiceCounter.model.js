'use strict';

const mongoose = require('mongoose');

const invoiceCounterSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, required: true },
  key: { type: String, required: true },
  sequence: { type: Number, default: 0 },
});

invoiceCounterSchema.index({ tenantId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('InvoiceCounter', invoiceCounterSchema);
