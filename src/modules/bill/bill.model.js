'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');
const softDeletePlugin = require('../../common/plugins/softDeletePlugin');
const {
  resolveBillPaidAmount,
  resolveBillRemainingAmount,
  resolveBillStatus,
  resolveBillTotalAmount,
} = require('./bill-status');
const { EXCHANGE_RATE_SOURCES } = require('../currency/currency-snapshot');

const BILL_STATUSES = ['draft', 'posted', 'partially_paid', 'paid', 'overdue', 'cancelled'];

const lineItemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 500 },
    quantity: { type: mongoose.Schema.Types.Decimal128, required: true },
    unitPrice: { type: mongoose.Schema.Types.Decimal128, required: true },
    lineSubtotal: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
    taxRateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxRate',
      default: null,
    },
    taxRate: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
    taxAmount: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
    lineTotal: { type: mongoose.Schema.Types.Decimal128, required: true },
    lineBaseSubtotal: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
    lineBaseTaxAmount: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
    lineBaseTotal: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
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

const billSchema = new mongoose.Schema(
  {
    billNumber: { type: String, required: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    supplierName: { type: String, required: true, trim: true, maxlength: 200 },
    supplierEmail: { type: String, trim: true, lowercase: true, default: '' },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: BILL_STATUSES, default: 'draft' },
    currency: { type: String, default: 'SAR', maxlength: 10 },
    documentCurrency: {
      type: String,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      match: [/^[A-Z]{3}$/, 'Document currency must be a 3-letter ISO code'],
      default() {
        return this.currency || this.baseCurrency || 'SAR';
      },
    },
    baseCurrency: {
      type: String,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
      match: [/^[A-Z]{3}$/, 'Base currency must be a 3-letter ISO code'],
      default: 'SAR',
    },
    exchangeRate: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('1'),
      validate: {
        validator(value) {
          const numeric = Number(value?.toString?.() ?? value);
          return Number.isFinite(numeric) && numeric > 0;
        },
        message: 'Exchange rate must be greater than zero',
      },
    },
    exchangeRateDate: {
      type: Date,
      default() {
        return this.issueDate || new Date();
      },
    },
    exchangeRateSource: {
      type: String,
      enum: EXCHANGE_RATE_SOURCES,
      default: 'company_rate',
    },
    exchangeRateProvider: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    isExchangeRateManualOverride: { type: Boolean, default: false },
    lineItems: { type: [lineItemSchema], default: [] },
    subtotal: { type: mongoose.Schema.Types.Decimal128, required: true },
    taxTotal: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
    total: { type: mongoose.Schema.Types.Decimal128, required: true },
    baseSubtotal: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
    baseTaxTotal: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
    baseTotal: {
      type: mongoose.Schema.Types.Decimal128,
      default: mongoose.Types.Decimal128.fromString('0'),
    },
    paidAmount: { type: Number, default: 0 },
    remainingAmount: {
      type: Number,
      default() {
        return Number(this.total?.toString?.() ?? this.total ?? 0);
      },
    },
    payments: { type: [paymentSchema], default: [] },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    apAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null,
    },
    postedJournalEntryId: {
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
    postedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        const dec = (value) => (value ? value.toString() : '0');

        ret.documentCurrency = ret.documentCurrency || ret.currency || ret.baseCurrency || 'SAR';
        ret.baseCurrency = ret.baseCurrency || 'SAR';
        ret.subtotal = dec(ret.subtotal);
        ret.taxTotal = dec(ret.taxTotal);
        ret.total = dec(ret.total);
        ret.exchangeRate = ret.exchangeRate
          ? ret.exchangeRate.toString()
          : ret.documentCurrency === ret.baseCurrency
            ? '1'
            : '0';
        const sameCurrency = ret.documentCurrency === ret.baseCurrency;
        ret.baseSubtotal = ret.baseSubtotal ? dec(ret.baseSubtotal) : sameCurrency ? ret.subtotal : '0';
        ret.baseTaxTotal = ret.baseTaxTotal ? dec(ret.baseTaxTotal) : sameCurrency ? ret.taxTotal : '0';
        ret.baseTotal = ret.baseTotal ? dec(ret.baseTotal) : sameCurrency ? ret.total : '0';
        const totalAmount = resolveBillTotalAmount(ret);
        ret.paidAmount = resolveBillPaidAmount(ret, totalAmount);
        ret.remainingAmount = resolveBillRemainingAmount(ret, totalAmount, ret.paidAmount);
        ret.status = resolveBillStatus(ret);
        ret.payments = Array.isArray(ret.payments) ? ret.payments : [];
        if (ret.lineItems) {
          ret.lineItems = ret.lineItems.map((item) => ({
            ...item,
            quantity: dec(item.quantity),
            unitPrice: dec(item.unitPrice),
            lineSubtotal: dec(item.lineSubtotal || item.lineTotal),
            taxRate: dec(item.taxRate),
            taxAmount: dec(item.taxAmount),
            lineTotal: dec(item.lineTotal),
            lineBaseSubtotal: item.lineBaseSubtotal
              ? dec(item.lineBaseSubtotal)
              : sameCurrency
                ? dec(item.lineSubtotal || item.lineTotal)
                : '0',
            lineBaseTaxAmount: item.lineBaseTaxAmount
              ? dec(item.lineBaseTaxAmount)
              : sameCurrency
                ? dec(item.taxAmount)
                : '0',
            lineBaseTotal: item.lineBaseTotal
              ? dec(item.lineBaseTotal)
              : sameCurrency
                ? dec(item.lineTotal)
                : '0',
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
