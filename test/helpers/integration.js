'use strict';

const { once } = require('events');
const createApp = require('../../src/app');
const authService = require('../../src/modules/auth/auth.service');
const accountService = require('../../src/modules/account/account.service');
const billingService = require('../../src/modules/billing/billing.service');
const fiscalPeriodService = require('../../src/modules/fiscal-period/fiscalPeriod.service');
const journalService = require('../../src/modules/journal/journal.service');
const { connectDatabase, disconnectDatabase } = require('../../src/config/database');
const { disconnectRedis } = require('../../src/config/redis');
const User = require('../../src/modules/user/user.model');
const Tenant = require('../../src/modules/tenant/tenant.model');
const { Role } = require('../../src/modules/auth/role.model');
const { Account } = require('../../src/modules/account/account.model');
const { TaxRate } = require('../../src/modules/tax/tax-rate.model');
const { ExchangeRate } = require('../../src/modules/exchange-rate/exchange-rate.model');
const { Plan } = require('../../src/modules/billing/plan.model');
const { TenantSubscription } = require('../../src/modules/billing/tenant-subscription.model');
const { JournalEntry } = require('../../src/modules/journal/journal.model');
const JournalCounter = require('../../src/modules/journal/journalCounter.model');
const { Invoice } = require('../../src/modules/invoice/invoice.model');
const InvoiceCounter = require('../../src/modules/invoice/invoiceCounter.model');
const { Bill } = require('../../src/modules/bill/bill.model');
const BillCounter = require('../../src/modules/bill/billCounter.model');
const { FiscalPeriod } = require('../../src/modules/fiscal-period/fiscalPeriod.model');
const AuditLog = require('../../src/modules/audit/audit.model');

let databaseConnected = false;

function uniqueSuffix() {
  return `${Date.now()}_${Math.round(Math.random() * 100000)}`;
}

async function ensureDatabase() {
  if (databaseConnected) {
    return;
  }

  await connectDatabase();
  databaseConnected = true;
}

async function closeDatabase() {
  if (!databaseConnected) {
    return;
  }

  await disconnectDatabase();
  await disconnectRedis();
  databaseConnected = false;
}

async function cleanupTenantData(tenantIds) {
  for (const tenantId of tenantIds) {
    await TaxRate.deleteMany({ tenantId });
    await ExchangeRate.deleteMany({ tenantId });
    await JournalEntry.deleteMany({ tenantId });
    await Invoice.deleteMany({ tenantId });
    await Bill.deleteMany({ tenantId });
    await Account.deleteMany({ tenantId });
    await FiscalPeriod.deleteMany({ tenantId });
    await JournalCounter.deleteMany({ tenantId });
    await InvoiceCounter.deleteMany({ tenantId });
    await BillCounter.deleteMany({ tenantId });
    await TenantSubscription.deleteMany({ tenantId });
    await AuditLog.collection.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Role.deleteMany({ tenantId });
    await Tenant.deleteOne({ _id: tenantId });
  }
}

async function createTenantFixture(options = {}) {
  const suffix = options.suffix || uniqueSuffix();
  const auditContext = options.auditContext || {
    ip: '127.0.0.1',
    userAgent: `node-test/${suffix}`,
  };

  const registration = await authService.register({
    email: `test_${suffix}@example.com`,
    password: options.password || 'TestPass1',
    name: options.name || 'Test User',
    companyName: options.companyName || `Test Tenant ${suffix}`,
    language: options.language || 'en',
  }, { auditContext });

  if (options.applyTemplate !== false) {
    await accountService.applyTemplate(registration.tenant._id, 'egyptian', {
      userId: registration.user._id,
      auditContext,
    });
  }

  if (options.createFiscalYear !== false) {
    await fiscalPeriodService.createFiscalYear(
      registration.tenant._id,
      { year: options.fiscalYear || new Date().getFullYear() },
      {
        userId: registration.user._id,
        auditContext,
      }
    );
  }

  let subscription = null;
  if (options.createSubscription !== false) {
    subscription = await createTenantSubscriptionFixture(
      registration.tenant._id,
      options.billingPlanCode || 'enterprise',
      options.subscriptionStatus || 'trialing'
    );
  }

  return {
    ...registration,
    subscription,
    auditContext,
  };
}

async function createTenantSubscriptionFixture(tenantId, planCode, status) {
  await billingService.ensureDefaultPlans();

  const plan = await Plan.findOne({
    code: planCode,
    isActive: true,
  });
  if (!plan) {
    throw new Error(`Billing plan fixture not found: ${planCode}`);
  }

  const now = new Date();
  const currentPeriodEnd = new Date(now);
  currentPeriodEnd.setUTCMonth(currentPeriodEnd.getUTCMonth() + 1);

  return TenantSubscription.findOneAndUpdate(
    { tenantId },
    {
      $set: {
        planId: plan._id,
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
  ).populate('planId');
}

async function getAccountsByCode(tenantId, codes) {
  const accounts = await Account.find({ tenantId, code: { $in: codes } });
  return new Map(accounts.map((account) => [account.code, account]));
}

async function createPostedEntry(tenantId, userId, entry, options = {}) {
  const created = await journalService.createEntry(tenantId, userId, entry, options);
  return journalService.postEntry(created._id, tenantId, userId, options);
}

async function createServer() {
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  if (!server) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    return {
      response,
      body: await response.json(),
    };
  }

  return {
    response,
    body: await response.text(),
  };
}

module.exports = {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
  getAccountsByCode,
  createPostedEntry,
  createServer,
  closeServer,
  fetchJson,
};
