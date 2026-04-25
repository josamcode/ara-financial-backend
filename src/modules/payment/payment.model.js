'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');

const PAYMENT_PROVIDERS = ['myfatoorah'];
const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'cancelled', 'expired'];

const paymentAttemptSchema = new mongoose.Schema(
  {
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: PAYMENT_PROVIDERS,
      required: true,
      default: 'myfatoorah',
      index: true,
    },
    status: {
      type: String,
      enum: PAYMENT_STATUSES,
      required: true,
      default: 'pending',
      index: true,
    },
    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 10,
    },
    customerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    customerEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 320,
    },
    customerMobile: {
      type: String,
      trim: true,
      maxlength: 50,
      default: '',
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    referenceType: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    providerInvoiceId: {
      type: String,
      trim: true,
      index: true,
      default: null,
    },
    providerPaymentId: {
      type: String,
      trim: true,
      index: true,
      default: null,
    },
    paymentUrl: {
      type: String,
      trim: true,
      default: null,
    },
    callbackUrl: {
      type: String,
      trim: true,
      default: null,
    },
    errorUrl: {
      type: String,
      trim: true,
      default: null,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
    failureReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    providerStatus: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    providerResponse: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.amount = ret.amount?.toString?.() ?? ret.amount;
        delete ret.__v;
        return ret;
      },
    },
  }
);

paymentAttemptSchema.plugin(tenantPlugin);

paymentAttemptSchema.index({ tenantId: 1, status: 1 });
paymentAttemptSchema.index({ provider: 1, providerInvoiceId: 1 });
paymentAttemptSchema.index({ provider: 1, providerPaymentId: 1 });
paymentAttemptSchema.index({ tenantId: 1, referenceType: 1, referenceId: 1 });

const PaymentAttempt = mongoose.model('PaymentAttempt', paymentAttemptSchema);

module.exports = {
  PaymentAttempt,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
};
