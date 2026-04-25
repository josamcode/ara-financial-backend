'use strict';

const mongoose = require('mongoose');
const { Plan } = require('./plan.model');
const { TenantSubscription } = require('./tenant-subscription.model');
const Tenant = require('../tenant/tenant.model');
const paymentService = require('../payment/payment.service');
const auditService = require('../audit/audit.service');
const { BadRequestError, NotFoundError } = require('../../common/errors');

const RESOURCE_TYPE = 'TenantSubscription';
const SUBSCRIPTION_REFERENCE_TYPE = 'subscription';

const DEFAULT_PLANS = [
  {
    code: 'free',
    name: 'Free',
    description: 'Default free monthly plan.',
    price: '0',
    currency: 'SAR',
    billingCycle: 'monthly',
    features: ['Basic access'],
    limits: {},
    isActive: true,
    sortOrder: 0,
  },
  {
    code: 'basic',
    name: 'Basic',
    description: 'Placeholder monthly plan. Final business pricing is not configured.',
    price: '99',
    currency: 'SAR',
    billingCycle: 'monthly',
    features: ['Core finance workspace'],
    limits: {},
    isActive: true,
    sortOrder: 10,
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'Placeholder monthly plan. Final business pricing is not configured.',
    price: '199',
    currency: 'SAR',
    billingCycle: 'monthly',
    features: ['Expanded finance workspace'],
    limits: {},
    isActive: true,
    sortOrder: 20,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    description: 'Custom pricing placeholder. Contact sales before collecting payment.',
    price: '0',
    currency: 'SAR',
    billingCycle: 'monthly',
    features: ['Custom enterprise setup'],
    limits: {},
    isActive: true,
    sortOrder: 30,
  },
];

function normalizeCode(value) {
  return String(value || '').trim().toLowerCase();
}

function decimalToString(value) {
  return value?.toString?.() ?? String(value);
}

function decimalToNumber(value) {
  const parsed = Number(decimalToString(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function toObjectIdString(value) {
  if (!value) return null;
  return value._id?.toString?.() || value.toString?.() || String(value);
}

function addBillingPeriod(start, billingCycle) {
  const end = new Date(start);
  if (billingCycle === 'yearly') {
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    return end;
  }

  end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

function clearPendingMetadata(metadata = {}) {
  const next = { ...(metadata || {}) };
  delete next.pendingPlanId;
  delete next.pendingPlanCode;
  delete next.pendingBillingCycle;
  delete next.pendingPlanPrice;
  delete next.pendingPlanCurrency;
  delete next.pendingPaymentAttemptId;
  delete next.pendingCheckoutAt;
  return next;
}

class BillingService {
  async ensureDefaultPlans() {
    const existingCount = await Plan.countDocuments();
    if (existingCount > 0) return;

    try {
      await Plan.bulkWrite(
        DEFAULT_PLANS.map((plan) => ({
          updateOne: {
            filter: { code: plan.code },
            update: { $setOnInsert: plan },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }

  async listActivePlans() {
    await this.ensureDefaultPlans();

    return Plan.find({ isActive: true }).sort({ sortOrder: 1, code: 1 });
  }

  async getCurrentSubscription(tenantId) {
    await this.ensureDefaultPlans();

    const existing = await TenantSubscription.findOne({ tenantId }).populate('planId');
    if (existing) return existing;

    return this._createDefaultSubscription(tenantId);
  }

  async checkout(tenantId, userId, data, options = {}) {
    await this.ensureDefaultPlans();

    const plan = await this._findActivePlan(data);
    const amount = decimalToNumber(plan.price);
    if (amount === null || amount <= 0) {
      throw new BadRequestError(
        'Selected plan does not require payment checkout',
        'BILLING_PLAN_NOT_PAYABLE'
      );
    }

    const tenant = await Tenant.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant not found');
    if (!tenant.companyEmail) {
      throw new BadRequestError(
        'Tenant company email is required before billing checkout',
        'BILLING_CUSTOMER_EMAIL_REQUIRED'
      );
    }

    const subscription = await this.getCurrentSubscription(tenantId);
    const planPrice = decimalToString(plan.price);
    const paymentResult = await paymentService.createMyFatoorahPayment(
      tenantId,
      userId,
      {
        amount: planPrice,
        currency: plan.currency,
        customerName: tenant.legalName || tenant.name,
        customerEmail: tenant.companyEmail,
        customerMobile: tenant.companyPhone || '',
        description: `ARA Financial ${plan.name} subscription`,
        referenceType: SUBSCRIPTION_REFERENCE_TYPE,
        referenceId: subscription._id,
        metadata: {
          billing: true,
          subscriptionId: subscription._id.toString(),
          planId: plan._id.toString(),
          planCode: plan.code,
          billingCycle: plan.billingCycle,
          planPrice,
          planCurrency: plan.currency,
        },
      },
      { auditContext: options.auditContext }
    );

    const paymentAttemptId = paymentResult.paymentAttempt._id;
    const pendingMetadata = {
      ...(subscription.metadata || {}),
      pendingPlanId: plan._id.toString(),
      pendingPlanCode: plan.code,
      pendingBillingCycle: plan.billingCycle,
      pendingPlanPrice: planPrice,
      pendingPlanCurrency: plan.currency,
      pendingPaymentAttemptId: paymentAttemptId.toString(),
      pendingCheckoutAt: new Date().toISOString(),
    };

    const updatedSubscription = await TenantSubscription.findOneAndUpdate(
      { _id: subscription._id, tenantId },
      {
        lastPaymentAttemptId: paymentAttemptId,
        metadata: pendingMetadata,
      },
      { new: true }
    ).populate('planId');

    await auditService.log({
      tenantId,
      userId,
      action: 'billing.checkout.created',
      resourceType: RESOURCE_TYPE,
      resourceId: updatedSubscription._id,
      newValues: {
        planId: plan._id,
        planCode: plan.code,
        billingCycle: plan.billingCycle,
        paymentAttemptId,
      },
      auditContext: options.auditContext,
    });

    return {
      subscription: updatedSubscription,
      paymentAttempt: paymentResult.paymentAttempt,
      paymentUrl: paymentResult.paymentUrl,
    };
  }

  async syncPayment(tenantId, userId, paymentAttemptId, options = {}) {
    const verificationResult = await paymentService.verifyPaymentAttempt(
      tenantId,
      userId,
      paymentAttemptId,
      { auditContext: options.auditContext }
    );
    const { paymentAttempt, verification } = verificationResult;

    if (paymentAttempt.referenceType !== SUBSCRIPTION_REFERENCE_TYPE) {
      throw new BadRequestError(
        'Payment attempt is not linked to a subscription',
        'BILLING_PAYMENT_REFERENCE_INVALID'
      );
    }

    if (paymentAttempt.status !== 'paid' || verification.status !== 'paid') {
      return {
        paymentAttempt,
        verification,
        subscription: null,
        activated: false,
      };
    }

    const activation = await this.activateSubscriptionFromPaymentAttempt(
      tenantId,
      userId,
      paymentAttempt,
      { auditContext: options.auditContext }
    );

    return {
      paymentAttempt,
      verification,
      subscription: activation.subscription,
      activated: activation.activated,
      alreadyProcessed: activation.alreadyProcessed,
    };
  }

  async activateSubscriptionFromPaymentAttempt(tenantId, userId, paymentAttempt, options = {}) {
    const subscriptionId = paymentAttempt.referenceId;
    if (!mongoose.Types.ObjectId.isValid(subscriptionId)) {
      throw new BadRequestError(
        'Payment attempt subscription reference is invalid',
        'BILLING_SUBSCRIPTION_REFERENCE_INVALID'
      );
    }

    const subscription = await TenantSubscription.findOne({
      _id: subscriptionId,
      tenantId,
    });

    if (!subscription) {
      throw new NotFoundError('Subscription not found');
    }

    const paymentAttemptId = paymentAttempt._id.toString();
    const metadata = subscription.metadata || {};
    if (
      subscription.status === 'active' &&
      metadata.activatedPaymentAttemptId === paymentAttemptId
    ) {
      return {
        subscription: await subscription.populate('planId'),
        activated: false,
        alreadyProcessed: true,
      };
    }

    if (
      toObjectIdString(subscription.lastPaymentAttemptId) !== paymentAttemptId ||
      metadata.pendingPaymentAttemptId !== paymentAttemptId
    ) {
      throw new BadRequestError(
        'Payment attempt is not the current billing checkout',
        'BILLING_PAYMENT_ATTEMPT_NOT_CURRENT'
      );
    }

    const planId = metadata.pendingPlanId || paymentAttempt.metadata?.planId;
    if (!mongoose.Types.ObjectId.isValid(planId)) {
      throw new BadRequestError('Billing checkout plan is invalid', 'BILLING_PLAN_REFERENCE_INVALID');
    }

    const plan = await Plan.findById(planId);
    if (!plan) throw new NotFoundError('Plan not found');

    this._assertPaymentMatchesCheckout(paymentAttempt, metadata);

    const currentPeriodStart = new Date();
    const currentPeriodEnd = addBillingPeriod(currentPeriodStart, plan.billingCycle);
    const nextMetadata = {
      ...clearPendingMetadata(metadata),
      activatedPaymentAttemptId: paymentAttemptId,
      activatedPlanId: plan._id.toString(),
      activatedPlanCode: plan.code,
      activatedBillingCycle: plan.billingCycle,
      activatedAt: currentPeriodStart.toISOString(),
    };

    const oldValues = {
      planId: subscription.planId,
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      lastPaymentAttemptId: subscription.lastPaymentAttemptId,
    };

    const updated = await TenantSubscription.findOneAndUpdate(
      {
        _id: subscription._id,
        tenantId,
        $or: [
          { 'metadata.activatedPaymentAttemptId': { $exists: false } },
          { 'metadata.activatedPaymentAttemptId': { $ne: paymentAttemptId } },
        ],
      },
      {
        planId: plan._id,
        status: 'active',
        trialEndsAt: null,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: false,
        lastPaymentAttemptId: paymentAttemptId,
        activatedAt: currentPeriodStart,
        cancelledAt: null,
        metadata: nextMetadata,
      },
      { new: true }
    ).populate('planId');

    if (!updated) {
      const alreadyProcessed = await TenantSubscription.findOne({
        _id: subscription._id,
        tenantId,
      }).populate('planId');

      return {
        subscription: alreadyProcessed,
        activated: false,
        alreadyProcessed: true,
      };
    }

    await auditService.log({
      tenantId,
      userId,
      action: 'billing.subscription.activated',
      resourceType: RESOURCE_TYPE,
      resourceId: updated._id,
      oldValues,
      newValues: {
        planId: updated.planId?._id || updated.planId,
        status: updated.status,
        currentPeriodStart: updated.currentPeriodStart,
        currentPeriodEnd: updated.currentPeriodEnd,
        lastPaymentAttemptId: paymentAttemptId,
      },
      auditContext: options.auditContext,
    });

    return {
      subscription: updated,
      activated: true,
      alreadyProcessed: false,
    };
  }

  async _findActivePlan({ planCode, billingCycle }) {
    const filter = {
      code: normalizeCode(planCode),
      isActive: true,
    };
    if (billingCycle) filter.billingCycle = billingCycle;

    const plan = await Plan.findOne(filter);
    if (!plan) throw new NotFoundError('Billing plan not found');
    return plan;
  }

  async _createDefaultSubscription(tenantId) {
    const freePlan = await Plan.findOne({
      code: 'free',
      billingCycle: 'monthly',
      isActive: true,
    });

    if (!freePlan || decimalToNumber(freePlan.price) !== 0) {
      throw new BadRequestError(
        'Default free billing plan is not configured safely',
        'BILLING_DEFAULT_PLAN_UNSAFE'
      );
    }

    return TenantSubscription.findOneAndUpdate(
      { tenantId },
      {
        $setOnInsert: {
          tenantId,
          planId: freePlan._id,
          status: 'trialing',
          cancelAtPeriodEnd: false,
          metadata: {
            createdByBillingDefault: true,
          },
        },
      },
      {
        new: true,
        upsert: true,
      }
    ).populate('planId');
  }

  _assertPaymentMatchesCheckout(paymentAttempt, metadata) {
    const expectedPaymentId = metadata.pendingPaymentAttemptId;
    if (expectedPaymentId !== paymentAttempt._id.toString()) {
      throw new BadRequestError(
        'Payment attempt does not match the pending billing checkout',
        'BILLING_PAYMENT_ATTEMPT_MISMATCH'
      );
    }

    const expectedAmount = metadata.pendingPlanPrice;
    const expectedCurrency = metadata.pendingPlanCurrency;
    if (!expectedAmount || !expectedCurrency) {
      throw new BadRequestError(
        'Billing checkout amount is missing',
        'BILLING_CHECKOUT_AMOUNT_MISSING'
      );
    }

    const amount = decimalToNumber(paymentAttempt.amount);
    const checkoutAmount = Number(expectedAmount);
    if (
      !Number.isFinite(amount) ||
      !Number.isFinite(checkoutAmount) ||
      Math.abs(amount - checkoutAmount) > 0.01
    ) {
      throw new BadRequestError(
        'Payment amount does not match the billing checkout',
        'BILLING_PAYMENT_AMOUNT_MISMATCH'
      );
    }

    if (String(paymentAttempt.currency).toUpperCase() !== String(expectedCurrency).toUpperCase()) {
      throw new BadRequestError(
        'Payment currency does not match the billing checkout',
        'BILLING_PAYMENT_CURRENCY_MISMATCH'
      );
    }
  }
}

module.exports = new BillingService();
