'use strict';

/**
 * Billing backend smoke check.
 *
 * By default this does not call MyFatoorah. Set BILLING_SMOKE_ENABLE_PAYMENT=true
 * only when you intentionally want to exercise the real payment gateway checkout.
 */

const mongoose = require('mongoose');
const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { disconnectRedis } = require('../src/config/redis');
const billingService = require('../src/modules/billing/billing.service');
const paymentService = require('../src/modules/payment/payment.service');
const Tenant = require('../src/modules/tenant/tenant.model');
const { Plan } = require('../src/modules/billing/plan.model');
const { TenantSubscription } = require('../src/modules/billing/tenant-subscription.model');
const { PaymentAttempt } = require('../src/modules/payment/payment.model');

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

  await PaymentAttempt.deleteMany({ tenantId });
  await TenantSubscription.deleteMany({ tenantId });
  await mongoose.connection.collection('auditlogs').deleteMany({ tenantId }).catch(() => {});
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

async function runNonProviderSmoke(tenant, userId) {
  const seedResult = await billingService.seedDefaultPlans();
  assert(seedResult.planCodes.includes('free'), 'default free plan is present');
  assert(seedResult.planCodes.includes('basic'), 'default basic plan is present');

  const activePlans = await billingService.listActivePlans();
  assert(activePlans.length >= 4, 'billing service lists active plans');

  const subscription = await billingService.getCurrentSubscription(tenant._id);
  assert(subscription.status === 'trialing', 'default tenant subscription is trialing');
  assert(subscription.planId?.code === 'free', 'default tenant subscription uses free plan');

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
  assertSafeSmokeEnvironment(process.env);

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

function assertSafeSmokeEnvironment(env) {
  const errors = [];
  const mongoUri = env.MONGODB_URI;

  if (env.NODE_ENV === 'production') {
    errors.push('NODE_ENV=production is not allowed for billing smoke.');
  }

  if (!mongoUri) {
    errors.push('MONGODB_URI is required for billing smoke.');
  } else {
    const mongoInfo = parseMongoUri(mongoUri);
    const dbName = (mongoInfo.dbName || '').toLowerCase();

    if (!/^mongodb(\+srv)?:\/\//i.test(mongoUri)) {
      errors.push('MONGODB_URI must be a MongoDB URI.');
    }

    if (mongoInfo.protocol === 'mongodb+srv:') {
      errors.push('Billing smoke refuses mongodb+srv URIs.');
    }

    if (mongoInfo.hosts.some((host) => host.includes('mongodb.net'))) {
      errors.push('Billing smoke refuses Atlas mongodb.net hosts.');
    }

    if (mongoInfo.hosts.some((host) => /(^|[.-])(prod|production|live)([.-]|$)/.test(host))) {
      errors.push(`MongoDB host looks production-like: "${mongoInfo.hosts.join(', ')}".`);
    }

    if (!mongoInfo.dbName) {
      errors.push('MONGODB_URI must include an explicit database name.');
    }

    if (/(^|[_-])(prod|production|live)($|[_-])/.test(dbName)) {
      errors.push(`MongoDB database name looks production-like: "${mongoInfo.dbName}".`);
    }
  }

  if (errors.length === 0) return;

  console.error('Billing smoke safety check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  console.error('Refusing to run billing smoke.');
  process.exit(1);
}

function parseMongoUri(uri) {
  const info = {
    protocol: null,
    hosts: [],
    dbName: '',
  };

  try {
    const parsed = new URL(uri);
    info.protocol = parsed.protocol.toLowerCase();
    info.hosts = parseHosts(parsed.host);
    info.dbName = decodeURIComponent(
      parsed.searchParams.get('dbName') || parsed.pathname.replace(/^\/+/, '').split('/')[0] || ''
    );
    return info;
  } catch {
    return parseMongoUriFallback(uri, info);
  }
}

function parseMongoUriFallback(uri, info) {
  const query = uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '';
  const dbNameParam = new URLSearchParams(query).get('dbName');
  const withoutProtocol = uri.replace(/^mongodb(\+srv)?:\/\//i, '');
  const withoutQuery = withoutProtocol.split(/[?#]/)[0];
  const withoutCredentials = withoutQuery.includes('@')
    ? withoutQuery.slice(withoutQuery.lastIndexOf('@') + 1)
    : withoutQuery;
  const slashIndex = withoutCredentials.indexOf('/');
  const hostPart = slashIndex >= 0 ? withoutCredentials.slice(0, slashIndex) : withoutCredentials;
  const pathPart = slashIndex >= 0 ? withoutCredentials.slice(slashIndex + 1) : '';

  info.protocol = uri.toLowerCase().startsWith('mongodb+srv://') ? 'mongodb+srv:' : 'mongodb:';
  info.hosts = parseHosts(hostPart);
  info.dbName = decodeURIComponent(dbNameParam || pathPart.split('/')[0] || '');
  return info;
}

function parseHosts(hostPart) {
  return hostPart
    .split(',')
    .map((host) => host.trim().replace(/^\[/, '').replace(/\]$/, '').split(':')[0].toLowerCase())
    .filter(Boolean);
}

main().catch((error) => {
  console.error('Billing smoke failed.');
  console.error(error.message);
  process.exitCode = 1;
});
