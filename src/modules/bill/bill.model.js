'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');
const softDeletePlugin = require('../../common/plugins/softDeletePlugin');

const BILL_STATUSES = ['draft'];

const lineItemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 500 },
    quantity: { type: mongoose.Schema.Types.Decimal128, required: true },
    unitPrice: { type: mongoose.Schema.Types.Decimal128, required: true },
    lineTotal: { type: mongoose.Schema.Types.Decimal128, required: true },
  },
  { _id: true }
);

const billSchema = new mongoose.Schema(
  {
    billNumber: { type: String, required: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    supplierName: { type: String, required: true, trim: true, maxlength: 200 },
    supplierEmail: { type: String, trim: true, lowercase: true, default: '' },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: BILL_STATUSES, default: 'draft' },
    currency: { type: String, default: 'EGP', maxlength: 10 },
    lineItems: { type: [lineItemSchema], default: [] },
    subtotal: { type: mongoose.Schema.Types.Decimal128, required: true },
    total: { type: mongoose.Schema.Types.Decimal128, required: true },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        const dec = (value) => (value ? value.toString() : '0');

        ret.subtotal = dec(ret.subtotal);
        ret.total = dec(ret.total);
        if (ret.lineItems) {
          ret.lineItems = ret.lineItems.map((item) => ({
            ...item,
            quantity: dec(item.quantity),
            unitPrice: dec(item.unitPrice),
            lineTotal: dec(item.lineTotal),
          }));
        }

        return ret;
      },
    },
  }
);

billSchema.plugin(tenantPlugin);
billSchema.plugin(softDeletePlugin);

billSchema.index({ tenantId: 1, billNumber: 1 }, { unique: true });
billSchema.index({ tenantId: 1, status: 1 });
billSchema.index({ tenantId: 1, dueDate: 1 });
billSchema.index({ tenantId: 1, createdBy: 1 });
billSchema.index({ tenantId: 1, supplierId: 1 });

const Bill = mongoose.model('Bill', billSchema);

module.exports = { Bill, BILL_STATUSES };
