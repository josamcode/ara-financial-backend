'use strict';

const { ForbiddenError } = require('../../common/errors');
const billingService = require('./billing.service');
const { TenantSubscription } = require('./tenant-subscription.model');
const User = require('../user/user.model');
const { Invoice } = require('../invoice/invoice.model');

const ALLOWED_WRITE_STATUSES = new Set(['trialing', 'active']);
const FALLBACK_LIMITS = Object.freeze({
  users: 1,
  invoicesPerMonth: 10,
});

function normalizeLimitValue(value) {
  if (value === null || value === undefined) return null;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;

  return Math.max(0, Math.floor(parsed));
}

function getPlanLimits(plan) {
  if (!plan) {
    return { ...FALLBACK_LIMITS };
  }

  const limits = plan.limits && typeof plan.limits === 'object' ? plan.limits : {};
  return {
    users: normalizeLimitValue(limits.users),
    invoicesPerMonth: normalizeLimitValue(limits.invoicesPerMonth),
  };
}

function getCurrentUtcMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

function buildUsageBucket(used, limit) {
  const normalizedLimit = normalizeLimitValue(limit);
  const unlimited = normalizedLimit === null;

  if (unlimited) {
    return {
      used,
      limit: null,
      unlimited: true,
      remaining: null,
      percent: null,
    };
  }

  return {
    used,
    limit: normalizedLimit,
    unlimited: false,
    remaining: Math.max(normalizedLimit - used, 0),
    percent: normalizedLimit <= 0
      ? (used > 0 ? 100 : 0)
      : Math.min(100, Math.round((used / normalizedLimit) * 100)),
  };
}

class BillingLimitsService {
  async getTenantBillingContext(tenantId, options = {}) {
    let subscription;

    if (options.createDefaultIfMissing) {
      subscription = await billingService.getCurrentSubscription(tenantId);
    } else {
      await billingService.ensureDefaultPlans();
      subscription = await TenantSubscription.findOne({ tenantId }).populate('planId');
    }

    const plan = subscription?.planId && typeof subscription.planId === 'object'
      ? subscription.planId
      : null;

    return {
      subscription: subscription || null,
      plan,
      limits: getPlanLimits(plan),
    };
  }

  async getUsageSummary(tenantId) {
    const context = await this.getTenantBillingContext(tenantId, {
      createDefaultIfMissing: true,
    });
    const [usersUsed, invoicesUsed] = await Promise.all([
      this.countActiveUsers(tenantId),
      this.countMonthlyInvoices(tenantId),
    ]);

    return {
      subscription: context.subscription,
      plan: context.plan,
      usage: {
        users: buildUsageBucket(usersUsed, context.limits.users),
        invoicesPerMonth: buildUsageBucket(invoicesUsed, context.limits.invoicesPerMonth),
      },
    };
  }

  async assertSubscriptionAllowsWrite(tenantId) {
    const context = await this.getTenantBillingContext(tenantId);

    if (!context.subscription) {
      throw new ForbiddenError(
        'A subscription is required to perform this action',
        'SUBSCRIPTION_REQUIRED'
      );
    }

    if (!ALLOWED_WRITE_STATUSES.has(context.subscription.status)) {
      throw new ForbiddenError(
        'Your subscription is not active',
        'SUBSCRIPTION_INACTIVE'
      );
    }

    return context;
  }

  async assertUserLimit(tenantId) {
    const context = await this.assertSubscriptionAllowsWrite(tenantId);
    const limit = context.limits.users;
    if (limit === null) return context;

    const used = await this.countActiveUsers(tenantId);
    if (used >= limit) {
      throw new ForbiddenError(
        'User limit reached for your current plan',
        'PLAN_LIMIT_EXCEEDED'
      );
    }

    return { ...context, usage: { users: { used, limit } } };
  }

  async assertMonthlyInvoiceLimit(tenantId) {
    const context = await this.assertSubscriptionAllowsWrite(tenantId);
    const limit = context.limits.invoicesPerMonth;
    if (limit === null) return context;

    const used = await this.countMonthlyInvoices(tenantId);
    if (used >= limit) {
      throw new ForbiddenError(
        'Monthly invoice limit reached for your current plan',
        'PLAN_LIMIT_EXCEEDED'
      );
    }

    return { ...context, usage: { invoicesPerMonth: { used, limit } } };
  }

  countActiveUsers(tenantId) {
    return User.countDocuments({
      tenantId,
      isActive: true,
      deletedAt: null,
    });
  }

  countMonthlyInvoices(tenantId, now = new Date()) {
    const { start, end } = getCurrentUtcMonthRange(now);

    return Invoice.countDocuments({
      tenantId,
      deletedAt: null,
      status: { $ne: 'cancelled' },
      createdAt: {
        $gte: start,
        $lt: end,
      },
    });
  }
}

module.exports = new BillingLimitsService();
