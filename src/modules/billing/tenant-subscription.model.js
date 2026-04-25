'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');

const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'expired', 'cancelled'];

const tenantSubscriptionSchema = new mongoose.Schema(
  {
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan',
      required: true,
    },
    status: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      required: true,
      default: 'trialing',
    },
    trialEndsAt: {
      type: Date,
      default: null,
    },
    currentPeriodStart: {
      type: Date,
      default: null,
    },
    currentPeriodEnd: {
      type: Date,
      default: null,
    },
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },
    lastPaymentAttemptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentAttempt',
      default: null,
    },
    activatedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
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
        delete ret.__v;
        return ret;
      },
    },
  }
);

tenantSubscriptionSchema.plugin(tenantPlugin);

tenantSubscriptionSchema.path('tenantId')._index = false;
tenantSubscriptionSchema.index({ tenantId: 1 }, { unique: true });
tenantSubscriptionSchema.index({ status: 1 });
tenantSubscriptionSchema.index({ planId: 1 });

const TenantSubscription = mongoose.model('TenantSubscription', tenantSubscriptionSchema);

module.exports = {
  TenantSubscription,
  SUBSCRIPTION_STATUSES,
};
