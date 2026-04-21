'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');
const softDeletePlugin = require('../../common/plugins/softDeletePlugin');
const {
  resolveInvoicePaidAmount,
  resolveInvoiceRemainingAmount,
  resolveInvoiceStatus,
  resolveInvoiceTotalAmount,
} = require('./invoice-status');

const INVOICE_STATUSES = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'cancelled'];

const lineItemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 500 },
    quantity: { type: mongoose.Schema.Types.Decimal128, required: true },
    unitPrice: { type: mongoose.Schema.Types.Decimal128, required: true },
    lineTotal: { type: mongoose.Schema.Types.Decimal128, required: true },
  },
  { _id: true }
);

const paymentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true, default: Date.now },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },
    journalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      required: true,
    },
  },
  { _id: true }
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerName: { type: String, required: true, trim: true, maxlength: 200 },
    customerEmail: { type: String, trim: true, lowercase: true, default: '' },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: INVOICE_STATUSES, default: 'draft' },
    currency: { type: String, default: 'EGP', maxlength: 10 },
    lineItems: { type: [lineItemSchema], default: [] },
    subtotal: { type: mongoose.Schema.Types.Decimal128, required: true },
    total: { type: mongoose.Schema.Types.Decimal128, required: true },
    paidAmount: { type: Number, default: 0 },
    remainingAmount: {
      type: Number,
      default() {
        return Number(this.total?.toString?.() ?? this.total ?? 0);
      },
    },
    payments: { type: [paymentSchema], default: [] },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    // Accounting links
    arAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null,
    },
    sentJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    paymentJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sentAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        const dec = (v) => (v ? v.toString() : '0');
        ret.subtotal = dec(ret.subtotal);
        ret.total = dec(ret.total);
        const totalAmount = resolveInvoiceTotalAmount(ret);
        ret.paidAmount = resolveInvoicePaidAmount(ret, totalAmount);
        ret.remainingAmount = resolveInvoiceRemainingAmount(ret, totalAmount, ret.paidAmount);
        ret.status = resolveInvoiceStatus(ret);
        ret.payments = Array.isArray(ret.payments) ? ret.payments : [];
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

invoiceSchema.plugin(tenantPlugin);
invoiceSchema.plugin(softDeletePlugin);

invoiceSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ tenantId: 1, status: 1 });
invoiceSchema.index({ tenantId: 1, dueDate: 1 });
invoiceSchema.index({ tenantId: 1, createdBy: 1 });
invoiceSchema.index({ tenantId: 1, customerId: 1 });

const Invoice = mongoose.model('Invoice', invoiceSchema);

module.exports = { Invoice, INVOICE_STATUSES };
