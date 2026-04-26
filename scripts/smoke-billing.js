'use strict';

/**
 * Billing backend smoke check.
 *
 * By default this does not call MyFatoorah. Set BILLING_SMOKE_ENABLE_PAYMENT=true
 * only when you intentionally want to exercise the real payment gateway checkout.
 */

const {
  configureSafeTestEnvironment,
  printSafeTestEnvironmentError,
} = require('./safe-test-env');

try {
  configureSafeTestEnvironment();
} catch (error) {
  printSafeTestEnvironmentError(error);
  process.exit(1);
}

const mongoose = require('mongoose');
const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { disconnectRedis } = require('../src/config/redis');
const billingService = require('../src/modules/billing/billing.service');
const billingLimitsService = require('../src/modules/billing/billing-limits.service');
const paymentService = require('../src/modules/payment/payment.service');
const Tenant = require('../src/modules/tenant/tenant.model');
const { Plan } = require('../src/modules/billing/plan.model');
const { TenantSubscription } = require('../src/modules/billing/tenant-subscription.model');
const { PaymentAttempt } = require('../src/modules/payment/payment.model');
const User = require('../src/modules/user/user.model');
const { Role } = require('../src/modules/auth/role.model');
const { Invoice } = require('../src/modules/invoice/invoice.model');

const SMOKE_AUDIT_CONTEXT = Object.freeze({
  ip: 'script://smoke-billing',
  userAgent: 'smoke-billing/1.0',
});

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS: ${label}`);
    passed++;
    return;
  }

  console.log(`FAIL: ${label}`);
  failed++;
}

async function assertDoesNotThrow(fn, label) {
  try {
    await fn();
    assert(true, label);
  } catch (error) {
    console.log(`Unexpected error for "${label}": ${error.code || error.message}`);
    assert(false, label);
  }
}

async function assertRejectsCode(fn, expectedCode, label) {
  try {
    await fn();
    assert(false, label);
  } catch (error) {
    assert(error?.code === expectedCode, label);
    if (error?.code !== expectedCode) {
      console.log(`Expected ${expectedCode}, received ${error?.code || error?.message}`);
    }
  }
}

function isTrue(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function decimalToNumber(value) {
  const parsed = Number(value?.toString?.() ?? value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function createSmokeTenant() {
  const suffix = `${Date.now()}_${Math.round(Math.random() * 100000)}`;

  return Tenant.create({
    name: `Billing Smoke ${suffix}`,
    legalName: `Billing Smoke ${suffix} LLC`,
    companyEmail: `billing_smoke_${suffix}@example.com`,
    companyPhone: '+966500000000',
    baseCurrency: 'SAR',
    status: 'active',
  });
}

async function cleanupSmokeTenant(tenantId) {
  if (!tenantId) return;

  await Invoice.deleteMany({ tenantId });
  await User.deleteMany({ tenantId });
  await Role.deleteMany({ tenantId });
  await PaymentAttempt.deleteMany({ tenantId });
  await TenantSubscription.deleteMany({ tenantId });
  await mongoose.connection.collection('auditlogs').deleteMany({ tenantId }).catch(() => {});
  await Plan.deleteMany({ code: /^smoke-limits-/ });
  await Tenant.deleteOne({ _id: tenantId });
}

async function findPayablePlan() {
  const plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1, code: 1 });
  return plans.find((plan) => decimalToNumber(plan.price) > 0);
}

function stubCreateMyFatoorahPayment() {
  const original = paymentService.createMyFatoorahPayment;

  paymentService.createMyFatoorahPayment = async (tenantId, userId, data) => {
    const attempt = await PaymentAttempt.create({
      tenantId,
      createdBy: userId,
      provider: 'myfatoorah',
      status: 'pending',
      amount: mongoose.Types.Decimal128.fromString(String(data.amount)),
      currency: data.currency,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      customerMobile: data.customerMobile || '',
      description: data.description || '',
      referenceType: data.referenceType || null,
      referenceId: data.referenceId || null,
      providerInvoiceId: `smoke-invoice-${Date.now()}`,
      paymentUrl: 'https://example.invalid/billing-smoke-payment',
      callbackUrl: 'http://localhost/api/v1/payments/myfatoorah/callback',
      errorUrl: 'http://localhost/api/v1/payments/myfatoorah/error',
      metadata: data.metadata || null,
    });

    return {
      paymentAttempt: attempt.toJSON(),
      paymentUrl: attempt.paymentUrl,
    };
  };

  return () => {
    paymentService.createMyFatoorahPayment = original;
  };
}

function stubVerifyPaymentAttempt() {
  const original = paymentService.verifyPaymentAttempt;

  paymentService.verifyPaymentAttempt = async (tenantId, _userId, paymentAttemptId) => {
    const existing = await PaymentAttempt.findOne({ _id: paymentAttemptId, tenantId });
    if (!existing) {
      throw new Error(`Smoke payment attempt not found: ${paymentAttemptId}`);
    }

    const updated = await PaymentAttempt.findOneAndUpdate(
      { _id: paymentAttemptId, tenantId },
      {
        status: 'paid',
        paidAt: existing.paidAt || new Date(),
        providerPaymentId: existing.providerPaymentId || `smoke-payment-${Date.now()}`,
        providerInvoiceId: existing.providerInvoiceId || `smoke-invoice-${Date.now()}`,
        providerStatus: 'Paid',
      },
      { returnDocument: 'after' }
    );

    return {
      paymentAttempt: updated.toJSON(),
      verification: {
        verified: true,
        status: 'paid',
        source: 'smoke',
        alreadyProcessed: existing.status === 'paid',
        paymentAttemptId: updated._id,
        providerInvoiceId: updated.providerInvoiceId,
        providerPaymentId: updated.providerPaymentId,
      },
    };
  };

  return () => {
    paymentService.verifyPaymentAttempt = original;
  };
}

async function createSmokeLimitsPlan(tenantId, limits) {
  return Plan.findOneAndUpdate(
    { code: `smoke-limits-${tenantId.toString()}` },
    {
      $set: {
        name: 'Smoke Limits',
        description: 'Temporary billing smoke limits plan.',
        price: mongoose.Types.Decimal128.fromString('0'),
        currency: 'SAR',
        billingCycle: 'monthly',
        features: ['Smoke limits'],
        limits,
        isActive: true,
        sortOrder: 9999,
      },
    },
    {
      upsert: true,
      returnDocument: 'after',
    }
  );
}

async function setSmokeSubscription(tenantId, planId, status) {
  const now = new Date();
  const currentPeriodEnd = new Date(now);
  currentPeriodEnd.setUTCMonth(currentPeriodEnd.getUTCMonth() + 1);

  return TenantSubscription.findOneAndUpdate(
    { tenantId },
    {
      $set: {
        planId,
        status,
        currentPeriodStart: now,
        currentPeriodEnd,
        cancelAtPeriodEnd: false,
      },
      $setOnInsert: {
        tenantId,
      },
    },
    {
      upsert: true,
      returnDocument: 'after',
    }
  );
}

async function createSmokeRole(tenantId) {
  return Role.create({
    tenantId,
    name: 'accountant',
    label: 'Smoke Accountant',
    permissions: [],
    isSystem: false,
  });
}

async function createSmokeUser(tenantId, roleId) {
  const suffix = `${Date.now()}_${Math.round(Math.random() * 100000)}`;

  return User.create({
    tenantId,
    roleId,
    email: `billing_limits_${suffix}@example.com`,
    passwordHash: 'SmokePassword123!',
    name: 'Billing Limits Smoke',
    isActive: true,
    emailVerified: true,
  });
}

async function createSmokeInvoice(tenantId, userId) {
  const amount = mongoose.Types.Decimal128.fromString('25');
  const now = new Date();
  const dueDate = new Date(now);
  dueDate.setUTCDate(dueDate.getUTCDate() + 7);

  return Invoice.create({
    tenantId,
    invoiceNumber: `SMOKE-${Date.now()}`,
    customerName: 'Smoke Customer',
    customerEmail: 'billing-smoke@example.com',
    issueDate: now,
    dueDate,
    status: 'draft',
    currency: 'SAR',
    lineItems: [
      {
        description: 'Smoke service',
        quantity: mongoose.Types.Decimal128.fromString('1'),
        unitPrice: amount,
        lineTotal: amount,
      },
    ],
    subtotal: amount,
    total: amount,
    paidAmount: 0,
    remainingAmount: 25,
    payments: [],
    notes: '',
    createdBy: userId,
  });
}

function hasDefaultLimitKeys(plan) {
  return (
    plan?.limits &&
    Object.prototype.hasOwnProperty.call(plan.limits, 'users') &&
    Object.prototype.hasOwnProperty.call(plan.limits, 'invoicesPerMonth')
  );
}

async function runLimitsSmoke(tenant, userId) {
  const defaultPlans = await Plan.find({
    code: { $in: ['free', 'basic', 'pro', 'enterprise'] },
  });
  assert(
    defaultPlans.length >= 4 && defaultPlans.every(hasDefaultLimitKeys),
    'default billing plans have users and invoicesPerMonth limits'
  );

  const limitPlan = await createSmokeLimitsPlan(tenant._id, {
    users: 1,
    invoicesPerMonth: 1,
  });
  await setSmokeSubscription(tenant._id, limitPlan._id, 'trialing');

  const role = await createSmokeRole(tenant._id);
  const smokeUser = await createSmokeUser(tenant._id, role._id);

  let usageSummary = await billingLimitsService.getUsageSummary(tenant._id);
  assert(
    usageSummary.usage.users.used === 1 &&
      usageSummary.usage.users.limit === 1 &&
      usageSummary.usage.users.remaining === 0,
    'usage summary computes user usage'
  );

  await assertRejectsCode(
    () => billingLimitsService.assertUserLimit(tenant._id),
    'PLAN_LIMIT_EXCEEDED',
    'user limit guard blocks when over limit'
  );

  await createSmokeInvoice(tenant._id, smokeUser._id);

  usageSummary = await billingLimitsService.getUsageSummary(tenant._id);
  assert(
    usageSummary.usage.invoicesPerMonth.used === 1 &&
      usageSummary.usage.invoicesPerMonth.limit === 1 &&
      usageSummary.usage.invoicesPerMonth.remaining === 0,
    'usage summary computes monthly invoice usage'
  );

  await assertRejectsCode(
    () => billingLimitsService.assertMonthlyInvoiceLimit(tenant._id),
    'PLAN_LIMIT_EXCEEDED',
    'invoice limit guard blocks when over limit'
  );

  limitPlan.limits = {
    users: 10,
    invoicesPerMonth: 10,
  };
  await limitPlan.save();

  await setSmokeSubscription(tenant._id, limitPlan._id, 'trialing');
  await assertDoesNotThrow(
    () => billingLimitsService.assertUserLimit(tenant._id),
    'trialing subscription allows restricted writes within limits'
  );

  await setSmokeSubscription(tenant._id, limitPlan._id, 'active');
  await assertDoesNotThrow(
    () => billingLimitsService.assertMonthlyInvoiceLimit(tenant._id),
    'active subscription allows restricted writes within limits'
  );

  for (const status of ['expired', 'cancelled', 'past_due']) {
    await setSmokeSubscription(tenant._id, limitPlan._id, status);
    await assertRejectsCode(
      () => billingLimitsService.assertSubscriptionAllowsWrite(tenant._id),
      'SUBSCRIPTION_INACTIVE',
      `${status} subscription blocks restricted writes`
    );
  }

  await TenantSubscription.deleteOne({ tenantId: tenant._id });
  await assertRejectsCode(
    () => billingLimitsService.assertSubscriptionAllowsWrite(tenant._id),
    'SUBSCRIPTION_REQUIRED',
    'missing subscription blocks restricted writes'
  );
}

async function runNonProviderSmoke(tenant, userId) {
  const seedResult = await billingService.seedDefaultPlans();
  assert(seedResult.planCodes.includes('free'), 'default free plan is present');
  assert(seedResult.planCodes.includes('basic'), 'default basic plan is present');

  const activePlans = await billingService.listActivePlans();
  assert(activePlans.length >= 4, 'billing service lists active plans');

  const subscription = await billingService.getCurrentSubscription(tenant._id);
  assert(subscription.status === 'trialing', 'default tenant subscription is trialing');
  assert(subscription.planId?.code === 'free', 'default tenant subscription uses free plan');

  await runLimitsSmoke(tenant, userId);

  const payablePlan = await findPayablePlan();
  assert(Boolean(payablePlan), 'a payable active billing plan exists for checkout smoke');
  if (!payablePlan) return;

  const restoreCreate = stubCreateMyFatoorahPayment();
  let checkoutResult;
  try {
    checkoutResult = await billingService.checkout(
      tenant._id,
      userId,
      { planCode: payablePlan.code, billingCycle: payablePlan.billingCycle },
      { auditContext: SMOKE_AUDIT_CONTEXT }
    );
  } finally {
    restoreCreate();
  }

  assert(Boolean(checkoutResult.paymentUrl), 'checkout returns paymentUrl');
  assert(
    checkoutResult.paymentAttempt.referenceType === 'subscription',
    'checkout PaymentAttempt referenceType is subscription'
  );
  assert(
    checkoutResult.paymentAttempt.referenceId.toString() === checkoutResult.subscription._id.toString(),
    'checkout PaymentAttempt referenceId points to tenant subscription'
  );

  const storedAttempt = await PaymentAttempt.findOne({
    _id: checkoutResult.paymentAttempt._id,
    tenantId: tenant._id,
  });
  assert(Boolean(storedAttempt), 'checkout stores PaymentAttempt');
  assert(storedAttempt.referenceType === 'subscription', 'stored PaymentAttempt is subscription-linked');

  const restoreVerify = stubVerifyPaymentAttempt();
  let firstSync;
  let secondSync;
  try {
    firstSync = await billingService.syncPayment(
      tenant._id,
      userId,
      storedAttempt._id,
      { auditContext: SMOKE_AUDIT_CONTEXT }
    );
    const firstPeriodEnd = firstSync.subscription.currentPeriodEnd.toISOString();
    secondSync = await billingService.syncPayment(
      tenant._id,
      userId,
      storedAttempt._id,
      { auditContext: SMOKE_AUDIT_CONTEXT }
    );
    const secondPeriodEnd = secondSync.subscription.currentPeriodEnd.toISOString();

    assert(firstSync.activated === true, 'first sync activates subscription');
    assert(secondSync.activated === false, 'second sync does not activate again');
    assert(secondSync.alreadyProcessed === true, 'second sync reports already processed');
    assert(firstPeriodEnd === secondPeriodEnd, 'second sync does not extend billing period');
  } finally {
    restoreVerify();
  }
}

async function runOptionalProviderCheckout(tenant, userId) {
  if (!isTrue(process.env.BILLING_SMOKE_ENABLE_PAYMENT)) {
    console.log('Skipping real MyFatoorah checkout. Set BILLING_SMOKE_ENABLE_PAYMENT=true to enable it.');
    return;
  }

  const payablePlan = await findPayablePlan();
  if (!payablePlan) {
    throw new Error('No payable active plan exists for provider checkout smoke.');
  }

  const result = await billingService.checkout(
    tenant._id,
    userId,
    { planCode: payablePlan.code, billingCycle: payablePlan.billingCycle },
    { auditContext: SMOKE_AUDIT_CONTEXT }
  );

  assert(Boolean(result.paymentUrl), 'real provider checkout returns paymentUrl');
}

async function main() {
  await connectDatabase();

  let tenant;
  const userId = new mongoose.Types.ObjectId();

  try {
    tenant = await createSmokeTenant();
    await runNonProviderSmoke(tenant, userId);
    await runOptionalProviderCheckout(tenant, userId);
  } finally {
    await cleanupSmokeTenant(tenant?._id);
    await disconnectDatabase();
    await disconnectRedis();
  }

  console.log(`Billing smoke result: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Billing smoke failed.');
  console.error(error.message);
  process.exitCode = 1;
});
