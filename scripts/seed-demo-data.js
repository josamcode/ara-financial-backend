'use strict';

const mongoose = require('mongoose');

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { disconnectRedis } = require('../src/config/redis');

const Tenant = require('../src/modules/tenant/tenant.model');
const User = require('../src/modules/user/user.model');
const { Role, DEFAULT_ROLES, PERMISSIONS } = require('../src/modules/auth/role.model');
const accountService = require('../src/modules/account/account.service');
const { Account } = require('../src/modules/account/account.model');
const { FiscalPeriod } = require('../src/modules/fiscal-period/fiscalPeriod.model');
const currencyService = require('../src/modules/currency/currency.service');
const exchangeRateService = require('../src/modules/exchange-rate/exchange-rate.service');
const { ExchangeRate } = require('../src/modules/exchange-rate/exchange-rate.model');
const taxService = require('../src/modules/tax/tax.service');
const { TaxRate } = require('../src/modules/tax/tax-rate.model');
const customerService = require('../src/modules/customer/customer.service');
const { Customer } = require('../src/modules/customer/customer.model');
const supplierService = require('../src/modules/supplier/supplier.service');
const { Supplier } = require('../src/modules/supplier/supplier.model');
const invoiceService = require('../src/modules/invoice/invoice.service');
const { Invoice } = require('../src/modules/invoice/invoice.model');
const billService = require('../src/modules/bill/bill.service');
const { Bill } = require('../src/modules/bill/bill.model');
const journalService = require('../src/modules/journal/journal.service');
const { JournalEntry } = require('../src/modules/journal/journal.model');

const DEMO_PREFIX = 'DEMO';
const DEMO_MARKER = 'DEMO-SEED';
const DEMO_PASSWORD = 'DemoPass123!';
const DEMO_EMAILS = {
  admin: 'demo.admin@ara.local',
  accountant: 'demo.accountant@ara.local',
  viewer: 'demo.viewer@ara.local',
};

const REQUIRED_ACCOUNT_DEFS = [
  { code: '1111', nameEn: 'Cash', nameAr: 'Cash', type: 'asset' },
  { code: '1112', nameEn: 'Bank', nameAr: 'Bank', type: 'asset' },
  { code: '1120', nameEn: 'Accounts Receivable', nameAr: 'Accounts Receivable', type: 'asset' },
  { code: '1130', nameEn: 'Inventory', nameAr: 'Inventory', type: 'asset' },
  { code: '2110', nameEn: 'Accounts Payable', nameAr: 'Accounts Payable', type: 'liability' },
  { code: '2140', nameEn: 'VAT Payable', nameAr: 'VAT Payable', type: 'liability' },
  { code: '2220', nameEn: 'Input VAT', nameAr: 'Input VAT', type: 'asset' },
  { code: '2230', nameEn: 'VAT Payable', nameAr: 'VAT Payable', type: 'liability' },
  { code: '3100', nameEn: 'Owner Capital', nameAr: 'Owner Capital', type: 'equity' },
  { code: '4100', nameEn: 'Sales Revenue', nameAr: 'Sales Revenue', type: 'revenue' },
  { code: '4310', nameEn: 'FX Gain', nameAr: 'FX Gain', type: 'revenue' },
  { code: '5200', nameEn: 'Operating Expense', nameAr: 'Operating Expense', type: 'expense' },
  { code: '5300', nameEn: 'Purchases / Cost of Goods', nameAr: 'Purchases / Cost of Goods', type: 'expense' },
  { code: '5910', nameEn: 'FX Loss', nameAr: 'FX Loss', type: 'expense' },
];

const CUSTOMER_DEFS = [
  ['DEMO-CUST-001', 'Local Retail Customer', 'retail.customer@demo.ara.local', '+966 11 100 0001', 'Riyadh, Saudi Arabia'],
  ['DEMO-CUST-002', 'Corporate Customer', 'corporate.customer@demo.ara.local', '+966 11 100 0002', 'Jeddah, Saudi Arabia'],
  ['DEMO-CUST-003', 'Foreign Customer USD', 'foreign.usd@demo.ara.local', '+1 212 555 0103', 'New York, USA'],
  ['DEMO-CUST-004', 'Customer With Partial Payments', 'partial.customer@demo.ara.local', '+966 11 100 0004', 'Dammam, Saudi Arabia'],
  ['DEMO-CUST-005', 'Customer With Overdue Invoice', 'overdue.customer@demo.ara.local', '+966 11 100 0005', 'Khobar, Saudi Arabia'],
];

const SUPPLIER_DEFS = [
  ['DEMO-SUP-001', 'Local Supplier', 'local.supplier@demo.ara.local', '+966 11 200 0001', 'Riyadh, Saudi Arabia'],
  ['DEMO-SUP-002', 'Office Expenses Supplier', 'office.supplier@demo.ara.local', '+966 11 200 0002', 'Jeddah, Saudi Arabia'],
  ['DEMO-SUP-003', 'Foreign Supplier USD', 'foreign.usd.supplier@demo.ara.local', '+1 415 555 0103', 'San Francisco, USA'],
  ['DEMO-SUP-004', 'Supplier With Partial Payments', 'partial.supplier@demo.ara.local', '+966 11 200 0004', 'Dammam, Saudi Arabia'],
  ['DEMO-SUP-005', 'Supplier With Overdue Bill', 'overdue.supplier@demo.ara.local', '+966 11 200 0005', 'Khobar, Saudi Arabia'],
];

const TAX_DEFS = [
  { code: 'VAT15-SALES', name: 'VAT 15% Sales', rate: '15', type: 'sales' },
  { code: 'VAT15-PURCHASE', name: 'VAT 15% Purchase', rate: '15', type: 'purchase' },
  { code: 'VAT15-BOTH', name: 'VAT 15% Both', rate: '15', type: 'both' },
  { code: 'VAT5-BOTH', name: 'VAT 5% Both', rate: '5', type: 'both' },
  { code: 'VAT0-SALES', name: 'VAT 0% Sales', rate: '0', type: 'sales' },
];

const PRODUCT_NAMES = [
  'Consulting Service',
  'Software Subscription',
  'Office Supplies',
  'Hardware Equipment',
  'Training Service',
];

function parseArgs(argv) {
  const args = {
    tenantId: process.env.DEMO_TENANT_ID || process.env.TENANT_ID || '',
    resetDemo: false,
    dryRun: false,
    verbose: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--tenantId=')) args.tenantId = arg.slice('--tenantId='.length);
    else if (arg === '--reset-demo') args.resetDemo = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  args.tenantId = String(args.tenantId || '').trim();
  return args;
}

function printHelp() {
  console.log('Usage: node scripts/seed-demo-data.js --tenantId=<tenantId> [--reset-demo] [--dry-run] [--verbose]');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/seed-demo-data.js --tenantId=69f13a03cba8f5f4d7a2921f --dry-run --verbose');
  console.log('  node scripts/seed-demo-data.js --tenantId=69f13a03cba8f5f4d7a2921f --verbose');
  console.log('  node scripts/seed-demo-data.js --tenantId=69f13a03cba8f5f4d7a2921f --reset-demo');
}

function iso(date) {
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  return new Date(date).toISOString().slice(0, 10);
}

function monthName(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function utcMonthStart(year, month) {
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
}

function utcMonthEnd(year, month) {
  return new Date(Date.UTC(year, month, 1, 0, 0, 0, 0) - 1);
}

function marker(key) {
  return `${DEMO_MARKER}:${key}`;
}

function notes(key, text = '') {
  return `${marker(key)} ${text}`.trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerRegex(key) {
  return new RegExp(escapeRegex(marker(key)));
}

function anyDemoRegex() {
  return new RegExp(escapeRegex(DEMO_MARKER));
}

function asId(value) {
  return value?._id?.toString?.() || value?.toString?.();
}

function withTenant(query, tenantId, options = {}) {
  return query.setOptions({ ...options, _tenantId: tenantId });
}

function createSummary() {
  return {
    tenant: null,
    accounts: { created: [], reused: [] },
    fiscalPeriods: { created: [], reused: [], opened: [] },
    users: { created: [], reused: [], skipped: [] },
    currencies: { created: 0, reused: 0, modified: 0, codes: [] },
    exchangeRates: { created: [], reused: [], updated: [] },
    taxRates: { created: [], reused: [], updated: [] },
    customers: { created: [], reused: [], updated: [] },
    suppliers: { created: [], reused: [], updated: [] },
    products: { skipped: [] },
    invoices: { created: [], reused: [], updated: [] },
    bills: { created: [], reused: [], updated: [] },
    journals: { created: [], reused: [] },
    reset: {},
    warnings: [],
  };
}

function verboseLog(options, message) {
  if (options.verbose) console.log(message);
}

async function findTenant(tenantId) {
  if (!tenantId) throw new Error('Missing tenantId. Pass --tenantId=<id> or set DEMO_TENANT_ID.');
  if (!mongoose.Types.ObjectId.isValid(tenantId)) {
    throw new Error(`Invalid tenantId: ${tenantId}`);
  }

  const tenant = await Tenant.findOne({ _id: tenantId, status: { $ne: 'deleted' } });
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
  return tenant;
}

async function seedRole(tenantId, name, def) {
  let role = await withTenant(Role.findOne({ tenantId, name }), tenantId);
  if (role) return { role, created: false };

  role = await Role.create({
    tenantId,
    name,
    label: def.label,
    permissions: def.permissions,
    isSystem: Boolean(def.isSystem),
  });

  return { role, created: true };
}

async function ensureRoles(tenantId) {
  const defs = {
    ...DEFAULT_ROLES,
    viewer: {
      name: 'viewer',
      label: 'Viewer',
      permissions: [
        PERMISSIONS.ACCOUNT_READ,
        PERMISSIONS.JOURNAL_READ,
        PERMISSIONS.REPORT_VIEW,
        PERMISSIONS.USER_READ,
        PERMISSIONS.TENANT_READ,
        PERMISSIONS.CURRENCY_READ,
        PERMISSIONS.EXCHANGE_RATE_READ,
        PERMISSIONS.FISCAL_READ,
        PERMISSIONS.INVOICE_READ,
        PERMISSIONS.CUSTOMER_READ,
        PERMISSIONS.SUPPLIER_READ,
        PERMISSIONS.BILL_READ,
        PERMISSIONS.TAX_READ,
        PERMISSIONS.AUDIT_READ,
        PERMISSIONS.DASHBOARD_VIEW,
      ].filter(Boolean),
      isSystem: false,
    },
  };

  const roles = {};
  for (const [name, def] of Object.entries(defs)) {
    const result = await seedRole(tenantId, name, def);
    roles[name] = result.role;
  }

  return roles;
}

async function ensureActorAndDemoUsers(tenantId, summary, options) {
  const existingActor = await withTenant(
    User.findOne({ tenantId, isActive: true }).sort({ createdAt: 1 }),
    tenantId
  );
  const roles = await ensureRoles(tenantId);
  let actor = existingActor;

  for (const [roleName, email] of Object.entries(DEMO_EMAILS)) {
    const existingGlobal = await User.findOne({ email }).setOptions({ __skipTenantFilter: true });
    if (existingGlobal && String(existingGlobal.tenantId) !== String(tenantId)) {
      summary.users.skipped.push(`${email} exists in another tenant`);
      continue;
    }

    if (existingGlobal) {
      summary.users.reused.push(email);
      if (!actor && existingGlobal.isActive) actor = existingGlobal;
      continue;
    }

    const role = roles[roleName] || roles.admin || roles.owner;
    const user = await User.create({
      tenantId,
      email,
      passwordHash: DEMO_PASSWORD,
      name: `${DEMO_PREFIX} ${role.label || roleName}`,
      roleId: role._id,
      isActive: true,
      emailVerified: true,
      language: 'en',
    });
    summary.users.created.push(email);
    if (!actor && roleName === 'admin') actor = user;
  }

  if (!actor) {
    throw new Error('No active user exists and demo admin user could not be created.');
  }

  verboseLog(options, `Using ${actor.email} as demo seed actor.`);
  return actor;
}

async function resetDemoData(tenantId, summary) {
  const invoiceDocs = await withTenant(
    Invoice.find({ tenantId, notes: anyDemoRegex() }).lean(),
    tenantId,
    { __includeDeleted: true }
  );
  const billDocs = await withTenant(
    Bill.find({ tenantId, notes: anyDemoRegex() }).lean(),
    tenantId,
    { __includeDeleted: true }
  );

  const journalIds = new Set();
  for (const invoice of invoiceDocs) {
    if (invoice.sentJournalEntryId) journalIds.add(String(invoice.sentJournalEntryId));
    if (invoice.paymentJournalEntryId) journalIds.add(String(invoice.paymentJournalEntryId));
    for (const payment of invoice.payments || []) {
      if (payment.journalEntryId) journalIds.add(String(payment.journalEntryId));
    }
  }
  for (const bill of billDocs) {
    if (bill.postedJournalEntryId) journalIds.add(String(bill.postedJournalEntryId));
    if (bill.paymentJournalEntryId) journalIds.add(String(bill.paymentJournalEntryId));
    for (const payment of bill.payments || []) {
      if (payment.journalEntryId) journalIds.add(String(payment.journalEntryId));
    }
  }

  const journalDeleteFilter = {
    tenantId,
    $or: [
      { reference: { $regex: `^${DEMO_PREFIX}` } },
      { description: anyDemoRegex() },
    ],
  };
  if (journalIds.size > 0) {
    journalDeleteFilter.$or.push({ _id: { $in: [...journalIds] } });
  }

  const results = {};
  results.invoices = await withTenant(Invoice.deleteMany({ tenantId, notes: anyDemoRegex() }), tenantId);
  results.bills = await withTenant(Bill.deleteMany({ tenantId, notes: anyDemoRegex() }), tenantId);
  results.journals = await withTenant(JournalEntry.deleteMany(journalDeleteFilter), tenantId);
  results.customers = await withTenant(Customer.deleteMany({ tenantId, notes: anyDemoRegex() }), tenantId);
  results.suppliers = await withTenant(Supplier.deleteMany({ tenantId, notes: anyDemoRegex() }), tenantId);
  results.taxRates = await withTenant(TaxRate.deleteMany({ tenantId, description: anyDemoRegex() }), tenantId);
  results.exchangeRates = await withTenant(ExchangeRate.deleteMany({ tenantId, notes: anyDemoRegex() }), tenantId);
  results.users = await withTenant(
    User.deleteMany({
      tenantId,
      email: { $in: Object.values(DEMO_EMAILS) },
    }),
    tenantId
  );

  summary.reset = Object.fromEntries(
    Object.entries(results).map(([key, result]) => [key, result.deletedCount || 0])
  );
}

async function ensureFiscalPeriods(tenantId, actorId, summary, options) {
  for (let month = 1; month <= 12; month += 1) {
    const name = monthName(2026, month);
    let period = await withTenant(FiscalPeriod.findOne({ tenantId, year: 2026, month }), tenantId);

    if (!period) {
      period = await FiscalPeriod.create({
        tenantId,
        name,
        startDate: utcMonthStart(2026, month),
        endDate: utcMonthEnd(2026, month),
        year: 2026,
        month,
        status: 'open',
      });
      summary.fiscalPeriods.created.push(name);
      continue;
    }

    summary.fiscalPeriods.reused.push(`${name}:${period.status}`);
    if (period.status === 'closed') {
      period.status = 'open';
      period.closedAt = null;
      period.closedBy = null;
      await period.save();
      summary.fiscalPeriods.opened.push(name);
    }
    if (period.status === 'locked' && month <= 5) {
      throw new Error(`Required demo transaction period ${name} is locked. Reopen it before seeding demo data.`);
    }
  }

  verboseLog(options, `Fiscal periods ready for tenant ${tenantId}; actor ${actorId}.`);
}

async function ensureAccounts(tenantId, actorId, summary) {
  const accounts = new Map();

  for (const def of REQUIRED_ACCOUNT_DEFS) {
    let account = await withTenant(Account.findOne({ tenantId, code: def.code }), tenantId);
    if (account) {
      summary.accounts.reused.push(`${def.code} ${account.nameEn}`);
      accounts.set(def.code, account);
      continue;
    }

    account = await accountService.createAccount(
      tenantId,
      {
        code: def.code,
        nameAr: def.nameAr,
        nameEn: def.nameEn,
        type: def.type,
      },
      { userId: actorId }
    );
    summary.accounts.created.push(`${def.code} ${def.nameEn}`);
    accounts.set(def.code, account);
  }

  try {
    await taxService.resolveOutputVatAccount(tenantId);
  } catch (_error) {
    const fallback = await accountService.createAccount(
      tenantId,
      {
        code: 'OUTPUT-VAT',
        nameAr: 'Output VAT',
        nameEn: 'Output VAT',
        type: 'liability',
      },
      { userId: actorId }
    );
    summary.accounts.created.push('OUTPUT-VAT Output VAT');
    accounts.set('OUTPUT-VAT', fallback);
  }

  try {
    await taxService.resolveInputVatAccount(tenantId);
  } catch (_error) {
    const fallback = await accountService.createAccount(
      tenantId,
      {
        code: 'INPUT-VAT',
        nameAr: 'Input VAT',
        nameEn: 'Input VAT',
        type: 'asset',
      },
      { userId: actorId }
    );
    summary.accounts.created.push('INPUT-VAT Input VAT');
    accounts.set('INPUT-VAT', fallback);
  }

  for (const code of ['1111', '1112', '1120', '2110', '3100', '4100', '4310', '5200', '5910']) {
    const account = accounts.get(code) || await withTenant(Account.findOne({ tenantId, code }), tenantId);
    if (!account || !account.isActive || account.isParentOnly) {
      throw new Error(`Required posting account ${code} is missing, inactive, or parent-only.`);
    }
    accounts.set(code, account);
  }

  return accounts;
}

async function ensureCurrencies(summary) {
  const result = await currencyService.seedDefaultCurrencies();
  summary.currencies.created = result.inserted;
  summary.currencies.reused = result.matched;
  summary.currencies.modified = result.modified;
  summary.currencies.codes = result.currencyCodes;
}

async function ensureExchangeRate(tenantId, actorId, payload, summary) {
  const existing = await withTenant(
    ExchangeRate.findOne({
      tenantId,
      fromCurrency: payload.fromCurrency,
      toCurrency: payload.toCurrency,
      effectiveDate: new Date(payload.effectiveDate),
      provider: payload.provider,
      notes: anyDemoRegex(),
    }),
    tenantId
  );

  if (!existing) {
    const created = await exchangeRateService.createExchangeRate(tenantId, actorId, payload);
    summary.exchangeRates.created.push(`${created.fromCurrency}->${created.toCurrency} ${iso(created.effectiveDate)}`);
    return created;
  }

  const desiredRate = String(payload.rate);
  if (
    existing.rate.toString() !== desiredRate ||
    existing.source !== payload.source ||
    existing.isActive !== true
  ) {
    await exchangeRateService.updateExchangeRate(tenantId, existing._id, {
      ...payload,
      isActive: true,
    });
    summary.exchangeRates.updated.push(`${payload.fromCurrency}->${payload.toCurrency} ${payload.effectiveDate}`);
  } else {
    summary.exchangeRates.reused.push(`${payload.fromCurrency}->${payload.toCurrency} ${payload.effectiveDate}`);
  }

  return withTenant(ExchangeRate.findOne({ _id: existing._id, tenantId }), tenantId);
}

async function ensureExchangeRates(tenantId, actorId, baseCurrency, summary) {
  const dates = ['2026-04-01', '2026-04-15', '2026-04-28'];
  const baseRates = {
    EGP: { baseToForeign: '14.08', foreignToBase: '0.071022727273' },
    USD: { baseToForeign: '0.266666666667', foreignToBase: '3.75' },
    EUR: { baseToForeign: '0.245', foreignToBase: '4.08' },
  };

  if (baseCurrency !== 'SAR') {
    summary.warnings.push(`Tenant base currency is ${baseCurrency}; SAR demo rate constants are still seeded for reference, but FX document scenarios are skipped.`);
  }

  for (const date of dates) {
    for (const [currency, rates] of Object.entries(baseRates)) {
      await ensureExchangeRate(tenantId, actorId, {
        fromCurrency: 'SAR',
        toCurrency: currency,
        rate: rates.baseToForeign,
        effectiveDate: date,
        source: 'manual',
        provider: 'Demo Seed',
        notes: notes(`FX-${date}-${currency}-FROM-SAR`, `${DEMO_PREFIX} exchange rate`),
      }, summary);
      await ensureExchangeRate(tenantId, actorId, {
        fromCurrency: currency,
        toCurrency: 'SAR',
        rate: rates.foreignToBase,
        effectiveDate: date,
        source: 'manual',
        provider: 'Demo Seed',
        notes: notes(`FX-${date}-${currency}-TO-SAR`, `${DEMO_PREFIX} exchange rate`),
      }, summary);
    }
  }
}

async function ensureTaxRates(tenantId, actorId, summary) {
  const rates = new Map();
  for (const def of TAX_DEFS) {
    let taxRate = await withTenant(TaxRate.findOne({ tenantId, code: def.code }), tenantId);
    if (!taxRate) {
      taxRate = await taxService.createTaxRate(tenantId, actorId, {
        ...def,
        description: notes(`TAX-${def.code}`, `${DEMO_PREFIX} tax rate`),
      });
      summary.taxRates.created.push(def.code);
    } else {
      const needsUpdate = (
        taxRate.rate.toString() !== def.rate ||
        taxRate.type !== def.type ||
        taxRate.isActive !== true ||
        !String(taxRate.description || '').includes(DEMO_MARKER)
      );
      if (needsUpdate) {
        taxRate = await taxService.updateTaxRate(taxRate._id, tenantId, actorId, {
          name: def.name,
          rate: def.rate,
          type: def.type,
          isActive: true,
          description: notes(`TAX-${def.code}`, `${DEMO_PREFIX} tax rate`),
        });
        summary.taxRates.updated.push(def.code);
      } else {
        summary.taxRates.reused.push(def.code);
      }
    }
    rates.set(def.code, taxRate);
  }
  return rates;
}

async function upsertParty({ Model, service, tenantId, actorId, def, type, summaryBucket }) {
  const [code, label, email, phone, address] = def;
  const key = `${type}-${code}`;
  let party = await withTenant(
    Model.findOne({
      tenantId,
      $or: [
        { name: `${code} ${label}` },
        { notes: markerRegex(key) },
      ],
    }),
    tenantId
  );

  const payload = {
    name: `${code} ${label}`,
    email,
    phone,
    address,
    notes: notes(key, `${DEMO_PREFIX} ${type.toLowerCase()} for demo seed`),
  };

  if (!party) {
    party = type === 'CUSTOMER'
      ? await service.createCustomer(tenantId, actorId, payload)
      : await service.createSupplier(tenantId, actorId, payload);
    summaryBucket.created.push(code);
    return party;
  }

  const changed = ['name', 'email', 'phone', 'address', 'notes'].some((field) => party[field] !== payload[field]);
  if (changed) {
    party = type === 'CUSTOMER'
      ? await service.updateCustomer(party._id, tenantId, actorId, payload)
      : await service.updateSupplier(party._id, tenantId, actorId, payload);
    summaryBucket.updated.push(code);
  } else {
    summaryBucket.reused.push(code);
  }
  return party;
}

async function ensureParties(tenantId, actorId, summary) {
  const customers = new Map();
  const suppliers = new Map();

  for (const def of CUSTOMER_DEFS) {
    const customer = await upsertParty({
      Model: Customer,
      service: customerService,
      tenantId,
      actorId,
      def,
      type: 'CUSTOMER',
      summaryBucket: summary.customers,
    });
    customers.set(def[0], customer);
  }

  for (const def of SUPPLIER_DEFS) {
    const supplier = await upsertParty({
      Model: Supplier,
      service: supplierService,
      tenantId,
      actorId,
      def,
      type: 'SUPPLIER',
      summaryBucket: summary.suppliers,
    });
    suppliers.set(def[0], supplier);
  }

  return { customers, suppliers };
}

function invoicePayload({ key, customer, issueDate, dueDate, amount, taxRate, documentCurrency, exchangeRate, description }) {
  return {
    customerId: asId(customer),
    customerName: customer.name,
    customerEmail: customer.email,
    issueDate,
    dueDate,
    currency: documentCurrency,
    documentCurrency,
    exchangeRate,
    exchangeRateDate: exchangeRate ? issueDate : undefined,
    exchangeRateSource: exchangeRate ? 'manual' : undefined,
    exchangeRateProvider: exchangeRate ? 'Demo Seed' : undefined,
    isExchangeRateManualOverride: Boolean(exchangeRate),
    lineItems: [{
      description,
      quantity: '1',
      unitPrice: amount,
      taxRateId: taxRate ? asId(taxRate) : null,
      lineTotal: amount,
    }],
    subtotal: amount,
    total: amount,
    notes: notes(key, `${DEMO_PREFIX} invoice scenario`),
  };
}

function billPayload({ key, supplier, issueDate, dueDate, amount, taxRate, documentCurrency, exchangeRate, description }) {
  return {
    supplierId: asId(supplier),
    supplierName: supplier.name,
    supplierEmail: supplier.email,
    issueDate,
    dueDate,
    currency: documentCurrency,
    documentCurrency,
    exchangeRate,
    exchangeRateDate: exchangeRate ? issueDate : undefined,
    exchangeRateSource: exchangeRate ? 'manual' : undefined,
    exchangeRateProvider: exchangeRate ? 'Demo Seed' : undefined,
    isExchangeRateManualOverride: Boolean(exchangeRate),
    lineItems: [{
      description,
      quantity: '1',
      unitPrice: amount,
      taxRateId: taxRate ? asId(taxRate) : null,
      lineTotal: amount,
    }],
    subtotal: amount,
    total: amount,
    notes: notes(key, `${DEMO_PREFIX} bill scenario`),
  };
}

async function findInvoiceByKey(tenantId, key) {
  return withTenant(Invoice.findOne({ tenantId, notes: markerRegex(key) }), tenantId);
}

async function findBillByKey(tenantId, key) {
  return withTenant(Bill.findOne({ tenantId, notes: markerRegex(key) }), tenantId);
}

async function ensureInvoiceScenario(tenantId, actorId, accounts, data, summary) {
  const existing = await findInvoiceByKey(tenantId, data.key);
  if (existing) {
    summary.invoices.reused.push(data.key);
    return existing;
  }

  let invoice = await invoiceService.createInvoice(
    tenantId,
    actorId,
    data.payload,
    { auditContext: { source: 'demo-seed', scenario: data.key } }
  );

  if (['sent', 'paid', 'partial', 'overdue', 'cancelled'].includes(data.finalState)) {
    invoice = await invoiceService.markAsSent(
      invoice._id,
      tenantId,
      actorId,
      {
        arAccountId: asId(accounts.get('1120')),
        revenueAccountId: asId(accounts.get('4100')),
      },
      { auditContext: { source: 'demo-seed', scenario: data.key } }
    );
  }

  for (const payment of data.payments || []) {
    invoice = await invoiceService.recordPayment(
      invoice._id,
      tenantId,
      actorId,
      {
        cashAccountId: asId(accounts.get('1111')),
        ...payment,
      },
      { auditContext: { source: 'demo-seed', scenario: data.key } }
    );
  }

  if (data.finalState === 'cancelled') {
    invoice = await invoiceService.cancelInvoice(
      invoice._id,
      tenantId,
      actorId,
      { auditContext: { source: 'demo-seed', scenario: data.key } }
    );
  }

  summary.invoices.created.push(data.key);
  return invoice;
}

async function ensureBillScenario(tenantId, actorId, accounts, data, summary) {
  const existing = await findBillByKey(tenantId, data.key);
  if (existing) {
    summary.bills.reused.push(data.key);
    return existing;
  }

  let bill = await billService.createBill(
    tenantId,
    actorId,
    data.payload,
    { auditContext: { source: 'demo-seed', scenario: data.key } }
  );

  if (['posted', 'paid', 'partial', 'overdue', 'cancelled'].includes(data.finalState)) {
    bill = await billService.postBill(
      bill._id,
      tenantId,
      actorId,
      {
        apAccountId: asId(accounts.get('2110')),
        debitAccountId: asId(accounts.get('5200')),
      },
      { auditContext: { source: 'demo-seed', scenario: data.key } }
    );
  }

  for (const payment of data.payments || []) {
    bill = await billService.recordPayment(
      bill._id,
      tenantId,
      actorId,
      {
        cashAccountId: asId(accounts.get('1111')),
        ...payment,
      },
      { auditContext: { source: 'demo-seed', scenario: data.key } }
    );
  }

  if (data.finalState === 'cancelled') {
    bill = await billService.cancelBill(
      bill._id,
      tenantId,
      actorId,
      { auditContext: { source: 'demo-seed', scenario: data.key } }
    );
  }

  summary.bills.created.push(data.key);
  return bill;
}

async function ensureInvoices(tenantId, actorId, baseCurrency, accounts, taxRates, customers, summary) {
  const base = baseCurrency;
  const scenarios = [
    {
      key: 'DEMO-INV-001-DRAFT',
      finalState: 'draft',
      payload: invoicePayload({
        key: 'DEMO-INV-001-DRAFT',
        customer: customers.get('DEMO-CUST-001'),
        issueDate: '2026-04-20',
        dueDate: '2026-05-20',
        amount: '900',
        taxRate: taxRates.get('VAT15-SALES'),
        documentCurrency: base,
        description: 'Consulting Service',
      }),
    },
    {
      key: 'DEMO-INV-002-SENT',
      finalState: 'sent',
      payload: invoicePayload({
        key: 'DEMO-INV-002-SENT',
        customer: customers.get('DEMO-CUST-002'),
        issueDate: '2026-04-21',
        dueDate: '2026-05-21',
        amount: '1200',
        taxRate: taxRates.get('VAT15-SALES'),
        documentCurrency: base,
        description: 'Software Subscription',
      }),
    },
    {
      key: 'DEMO-INV-003-PAID',
      finalState: 'paid',
      payload: invoicePayload({
        key: 'DEMO-INV-003-PAID',
        customer: customers.get('DEMO-CUST-001'),
        issueDate: '2026-03-05',
        dueDate: '2026-04-05',
        amount: '700',
        taxRate: taxRates.get('VAT15-SALES'),
        documentCurrency: base,
        description: 'Training Service',
      }),
      payments: [{ amount: '805', paymentDate: '2026-03-15', reference: 'DEMO-PAY-INV-003' }],
    },
    {
      key: 'DEMO-INV-004-PARTIAL',
      finalState: 'partial',
      payload: invoicePayload({
        key: 'DEMO-INV-004-PARTIAL',
        customer: customers.get('DEMO-CUST-004'),
        issueDate: '2026-04-10',
        dueDate: '2026-05-10',
        amount: '2000',
        taxRate: taxRates.get('VAT15-SALES'),
        documentCurrency: base,
        description: 'Implementation Services',
      }),
      payments: [{ amount: '800', paymentDate: '2026-04-18', reference: 'DEMO-PAY-INV-004' }],
    },
    {
      key: 'DEMO-INV-005-OVERDUE',
      finalState: 'overdue',
      payload: invoicePayload({
        key: 'DEMO-INV-005-OVERDUE',
        customer: customers.get('DEMO-CUST-005'),
        issueDate: '2026-03-10',
        dueDate: '2026-04-10',
        amount: '1500',
        taxRate: taxRates.get('VAT15-SALES'),
        documentCurrency: base,
        description: 'Monthly Services',
      }),
    },
    {
      key: 'DEMO-INV-006-CANCELLED',
      finalState: 'cancelled',
      payload: invoicePayload({
        key: 'DEMO-INV-006-CANCELLED',
        customer: customers.get('DEMO-CUST-002'),
        issueDate: '2026-04-08',
        dueDate: '2026-05-08',
        amount: '300',
        taxRate: taxRates.get('VAT15-SALES'),
        documentCurrency: base,
        description: 'Cancelled Consulting',
      }),
    },
    {
      key: 'DEMO-INV-007-VAT15',
      finalState: 'sent',
      payload: invoicePayload({
        key: 'DEMO-INV-007-VAT15',
        customer: customers.get('DEMO-CUST-001'),
        issueDate: '2026-04-12',
        dueDate: '2026-05-12',
        amount: '1000',
        taxRate: taxRates.get('VAT15-SALES'),
        documentCurrency: base,
        description: 'VAT 15% Sale',
      }),
    },
    {
      key: 'DEMO-INV-008-VAT5',
      finalState: 'sent',
      payload: invoicePayload({
        key: 'DEMO-INV-008-VAT5',
        customer: customers.get('DEMO-CUST-001'),
        issueDate: '2026-04-13',
        dueDate: '2026-05-13',
        amount: '800',
        taxRate: taxRates.get('VAT5-BOTH'),
        documentCurrency: base,
        description: 'VAT 5% Sale',
      }),
    },
    {
      key: 'DEMO-INV-009-VAT0',
      finalState: 'sent',
      payload: invoicePayload({
        key: 'DEMO-INV-009-VAT0',
        customer: customers.get('DEMO-CUST-001'),
        issueDate: '2026-04-14',
        dueDate: '2026-05-14',
        amount: '500',
        taxRate: taxRates.get('VAT0-SALES'),
        documentCurrency: base,
        description: 'Zero-rated Export Service',
      }),
    },
  ];

  if (baseCurrency === 'SAR') {
    scenarios.push(
      {
        key: 'DEMO-INV-010-USD',
        finalState: 'sent',
        payload: invoicePayload({
          key: 'DEMO-INV-010-USD',
          customer: customers.get('DEMO-CUST-003'),
          issueDate: '2026-04-15',
          dueDate: '2026-05-15',
          amount: '1000',
          taxRate: taxRates.get('VAT15-SALES'),
          documentCurrency: 'USD',
          exchangeRate: '3.75',
          description: 'Foreign Currency USD Service',
        }),
      },
      {
        key: 'DEMO-INV-011-EGP',
        finalState: 'sent',
        payload: invoicePayload({
          key: 'DEMO-INV-011-EGP',
          customer: customers.get('DEMO-CUST-003'),
          issueDate: '2026-04-16',
          dueDate: '2026-05-16',
          amount: '10000',
          taxRate: taxRates.get('VAT15-SALES'),
          documentCurrency: 'EGP',
          exchangeRate: '0.071022727273',
          description: 'Foreign Currency EGP Service',
        }),
      },
      {
        key: 'DEMO-INV-012-FX-GAIN',
        finalState: 'paid',
        payload: invoicePayload({
          key: 'DEMO-INV-012-FX-GAIN',
          customer: customers.get('DEMO-CUST-003'),
          issueDate: '2026-04-17',
          dueDate: '2026-05-17',
          amount: '400',
          taxRate: null,
          documentCurrency: 'USD',
          exchangeRate: '3.75',
          description: 'USD Invoice Paid With FX Gain',
        }),
        payments: [{
          amount: '400',
          paymentDate: '2026-04-28',
          paymentCurrency: 'USD',
          paymentExchangeRate: '3.80',
          paymentExchangeRateDate: '2026-04-28',
          paymentExchangeRateSource: 'manual',
          reference: 'DEMO-PAY-INV-012',
        }],
      },
      {
        key: 'DEMO-INV-013-FX-LOSS',
        finalState: 'paid',
        payload: invoicePayload({
          key: 'DEMO-INV-013-FX-LOSS',
          customer: customers.get('DEMO-CUST-003'),
          issueDate: '2026-04-18',
          dueDate: '2026-05-18',
          amount: '400',
          taxRate: null,
          documentCurrency: 'USD',
          exchangeRate: '3.75',
          description: 'USD Invoice Paid With FX Loss',
        }),
        payments: [{
          amount: '400',
          paymentDate: '2026-04-28',
          paymentCurrency: 'USD',
          paymentExchangeRate: '3.70',
          paymentExchangeRateDate: '2026-04-28',
          paymentExchangeRateSource: 'manual',
          reference: 'DEMO-PAY-INV-013',
        }],
      }
    );
  }

  for (const scenario of scenarios) {
    await ensureInvoiceScenario(tenantId, actorId, accounts, scenario, summary);
  }
}

async function ensureBills(tenantId, actorId, baseCurrency, accounts, taxRates, suppliers, summary) {
  const base = baseCurrency;
  const scenarios = [
    {
      key: 'DEMO-BILL-001-DRAFT',
      finalState: 'draft',
      payload: billPayload({
        key: 'DEMO-BILL-001-DRAFT',
        supplier: suppliers.get('DEMO-SUP-001'),
        issueDate: '2026-04-20',
        dueDate: '2026-05-20',
        amount: '600',
        taxRate: taxRates.get('VAT15-PURCHASE'),
        documentCurrency: base,
        description: 'Draft Office Supplies',
      }),
    },
    {
      key: 'DEMO-BILL-002-POSTED',
      finalState: 'posted',
      payload: billPayload({
        key: 'DEMO-BILL-002-POSTED',
        supplier: suppliers.get('DEMO-SUP-002'),
        issueDate: '2026-04-21',
        dueDate: '2026-05-21',
        amount: '950',
        taxRate: taxRates.get('VAT15-PURCHASE'),
        documentCurrency: base,
        description: 'Office Expense Bill',
      }),
    },
    {
      key: 'DEMO-BILL-003-PAID',
      finalState: 'paid',
      payload: billPayload({
        key: 'DEMO-BILL-003-PAID',
        supplier: suppliers.get('DEMO-SUP-001'),
        issueDate: '2026-03-06',
        dueDate: '2026-04-06',
        amount: '400',
        taxRate: taxRates.get('VAT15-PURCHASE'),
        documentCurrency: base,
        description: 'Paid Local Purchase',
      }),
      payments: [{ amount: '460', paymentDate: '2026-03-16', reference: 'DEMO-PAY-BILL-003' }],
    },
    {
      key: 'DEMO-BILL-004-PARTIAL',
      finalState: 'partial',
      payload: billPayload({
        key: 'DEMO-BILL-004-PARTIAL',
        supplier: suppliers.get('DEMO-SUP-004'),
        issueDate: '2026-04-11',
        dueDate: '2026-05-11',
        amount: '1800',
        taxRate: taxRates.get('VAT15-PURCHASE'),
        documentCurrency: base,
        description: 'Partially Paid Purchase',
      }),
      payments: [{ amount: '700', paymentDate: '2026-04-18', reference: 'DEMO-PAY-BILL-004' }],
    },
    {
      key: 'DEMO-BILL-005-OVERDUE',
      finalState: 'overdue',
      payload: billPayload({
        key: 'DEMO-BILL-005-OVERDUE',
        supplier: suppliers.get('DEMO-SUP-005'),
        issueDate: '2026-03-12',
        dueDate: '2026-04-10',
        amount: '1300',
        taxRate: taxRates.get('VAT15-PURCHASE'),
        documentCurrency: base,
        description: 'Overdue Supplier Bill',
      }),
    },
    {
      key: 'DEMO-BILL-006-CANCELLED',
      finalState: 'cancelled',
      payload: billPayload({
        key: 'DEMO-BILL-006-CANCELLED',
        supplier: suppliers.get('DEMO-SUP-002'),
        issueDate: '2026-04-08',
        dueDate: '2026-05-08',
        amount: '280',
        taxRate: taxRates.get('VAT15-PURCHASE'),
        documentCurrency: base,
        description: 'Cancelled Supplier Bill',
      }),
    },
    {
      key: 'DEMO-BILL-007-VAT15',
      finalState: 'posted',
      payload: billPayload({
        key: 'DEMO-BILL-007-VAT15',
        supplier: suppliers.get('DEMO-SUP-001'),
        issueDate: '2026-04-12',
        dueDate: '2026-05-12',
        amount: '1000',
        taxRate: taxRates.get('VAT15-PURCHASE'),
        documentCurrency: base,
        description: 'VAT 15% Purchase',
      }),
    },
    {
      key: 'DEMO-BILL-008-VAT5',
      finalState: 'posted',
      payload: billPayload({
        key: 'DEMO-BILL-008-VAT5',
        supplier: suppliers.get('DEMO-SUP-002'),
        issueDate: '2026-04-13',
        dueDate: '2026-05-13',
        amount: '800',
        taxRate: taxRates.get('VAT5-BOTH'),
        documentCurrency: base,
        description: 'VAT 5% Purchase',
      }),
    },
  ];

  if (baseCurrency === 'SAR') {
    scenarios.push(
      {
        key: 'DEMO-BILL-009-USD',
        finalState: 'posted',
        payload: billPayload({
          key: 'DEMO-BILL-009-USD',
          supplier: suppliers.get('DEMO-SUP-003'),
          issueDate: '2026-04-15',
          dueDate: '2026-05-15',
          amount: '1000',
          taxRate: taxRates.get('VAT15-PURCHASE'),
          documentCurrency: 'USD',
          exchangeRate: '3.75',
          description: 'Foreign Currency USD Purchase',
        }),
      },
      {
        key: 'DEMO-BILL-010-EGP',
        finalState: 'posted',
        payload: billPayload({
          key: 'DEMO-BILL-010-EGP',
          supplier: suppliers.get('DEMO-SUP-003'),
          issueDate: '2026-04-16',
          dueDate: '2026-05-16',
          amount: '10000',
          taxRate: taxRates.get('VAT15-PURCHASE'),
          documentCurrency: 'EGP',
          exchangeRate: '0.071022727273',
          description: 'Foreign Currency EGP Purchase',
        }),
      },
      {
        key: 'DEMO-BILL-011-FX-GAIN',
        finalState: 'paid',
        payload: billPayload({
          key: 'DEMO-BILL-011-FX-GAIN',
          supplier: suppliers.get('DEMO-SUP-003'),
          issueDate: '2026-04-17',
          dueDate: '2026-05-17',
          amount: '400',
          taxRate: null,
          documentCurrency: 'USD',
          exchangeRate: '3.75',
          description: 'USD Bill Paid With FX Gain',
        }),
        payments: [{
          amount: '400',
          paymentDate: '2026-04-28',
          paymentCurrency: 'USD',
          paymentExchangeRate: '3.70',
          paymentExchangeRateDate: '2026-04-28',
          paymentExchangeRateSource: 'manual',
          reference: 'DEMO-PAY-BILL-011',
        }],
      },
      {
        key: 'DEMO-BILL-012-FX-LOSS',
        finalState: 'paid',
        payload: billPayload({
          key: 'DEMO-BILL-012-FX-LOSS',
          supplier: suppliers.get('DEMO-SUP-003'),
          issueDate: '2026-04-18',
          dueDate: '2026-05-18',
          amount: '400',
          taxRate: null,
          documentCurrency: 'USD',
          exchangeRate: '3.75',
          description: 'USD Bill Paid With FX Loss',
        }),
        payments: [{
          amount: '400',
          paymentDate: '2026-04-28',
          paymentCurrency: 'USD',
          paymentExchangeRate: '3.80',
          paymentExchangeRateDate: '2026-04-28',
          paymentExchangeRateSource: 'manual',
          reference: 'DEMO-PAY-BILL-012',
        }],
      }
    );
  }

  for (const scenario of scenarios) {
    await ensureBillScenario(tenantId, actorId, accounts, scenario, summary);
  }
}

async function ensureManualJournal(tenantId, actorId, key, payload, summary) {
  const existing = await withTenant(JournalEntry.findOne({ tenantId, reference: key }), tenantId);
  if (existing) {
    summary.journals.reused.push(key);
    return existing;
  }

  const entry = await journalService.createEntry(
    tenantId,
    actorId,
    {
      ...payload,
      reference: key,
      description: `${marker(key)} ${payload.description}`,
    },
    { auditContext: { source: 'demo-seed', scenario: key } }
  );
  await journalService.postEntry(entry._id, tenantId, actorId, {
    auditContext: { source: 'demo-seed', scenario: key },
  });
  summary.journals.created.push(key);
  return entry;
}

async function ensureManualJournals(tenantId, actorId, accounts, summary) {
  await ensureManualJournal(tenantId, actorId, 'DEMO-JE-001', {
    date: '2026-01-05',
    description: 'Owner capital introduction',
    lines: [
      { accountId: asId(accounts.get('1112')), debit: '50000', credit: '0', description: 'Initial bank deposit' },
      { accountId: asId(accounts.get('3100')), debit: '0', credit: '50000', description: 'Owner capital' },
    ],
  }, summary);

  await ensureManualJournal(tenantId, actorId, 'DEMO-JE-002', {
    date: '2026-02-10',
    description: 'Operating expense paid from cash',
    lines: [
      { accountId: asId(accounts.get('5200')), debit: '1200', credit: '0', description: 'Operating expense' },
      { accountId: asId(accounts.get('1111')), debit: '0', credit: '1200', description: 'Cash payment' },
    ],
  }, summary);

  await ensureManualJournal(tenantId, actorId, 'DEMO-JE-003', {
    date: '2026-03-03',
    description: 'Cash deposited to bank',
    lines: [
      { accountId: asId(accounts.get('1112')), debit: '5000', credit: '0', description: 'Bank deposit' },
      { accountId: asId(accounts.get('1111')), debit: '0', credit: '5000', description: 'Cash transfer' },
    ],
  }, summary);
}

function printDryRunPlan(tenant, options) {
  console.log('Dry run: no writes will be performed.');
  console.log(`Tenant: ${tenant.name} (${tenant._id})`);
  console.log(`Base currency: ${tenant.baseCurrency || 'SAR'}`);
  console.log('');
  console.log('Planned actions:');
  console.log('- Validate tenant and database connection');
  if (options.resetDemo) console.log('- Delete only records for this tenant marked with DEMO-SEED / DEMO references');
  console.log('- Ensure 2026 monthly fiscal periods are present and open where needed');
  console.log('- Ensure required posting accounts, VAT accounts, FX gain/loss accounts');
  console.log('- Ensure demo admin/accountant/viewer users if safe');
  console.log('- Ensure SAR, EGP, USD, EUR currencies and demo exchange rates');
  console.log('- Ensure VAT tax rates: VAT15-SALES, VAT15-PURCHASE, VAT15-BOTH, VAT5-BOTH, VAT0-SALES');
  console.log('- Upsert five demo customers and five demo suppliers');
  console.log('- Skip products because src/modules/product is not present');
  console.log('- Create/reuse invoice scenarios: draft, sent, paid, partial, overdue, cancelled, VAT 15/5/0, USD, EGP, FX gain, FX loss');
  console.log('- Create/reuse bill scenarios: draft, posted, paid, partial, overdue, cancelled, VAT 15/5, USD, EGP, FX gain, FX loss');
  console.log('- Create/reuse posted manual journals: owner capital, operating expense, bank transfer');
}

function printSummary(summary) {
  console.log('');
  console.log('Demo seed completed.');
  console.log(`Tenant: ${summary.tenant.name} (${summary.tenant.tenantId})`);
  console.log(`Base currency: ${summary.tenant.baseCurrency}`);
  console.log('');
  if (Object.keys(summary.reset).length > 0) {
    console.log('Reset deleted:');
    for (const [key, value] of Object.entries(summary.reset)) console.log(`  ${key}: ${value}`);
    console.log('');
  }
  console.log(`Accounts created/reused: ${summary.accounts.created.length}/${summary.accounts.reused.length}`);
  console.log(`Fiscal periods created/reused/opened: ${summary.fiscalPeriods.created.length}/${summary.fiscalPeriods.reused.length}/${summary.fiscalPeriods.opened.length}`);
  console.log(`Currencies inserted/reused/modified: ${summary.currencies.created}/${summary.currencies.reused}/${summary.currencies.modified}`);
  console.log(`Exchange rates created/reused/updated: ${summary.exchangeRates.created.length}/${summary.exchangeRates.reused.length}/${summary.exchangeRates.updated.length}`);
  console.log(`Tax rates created/reused/updated: ${summary.taxRates.created.length}/${summary.taxRates.reused.length}/${summary.taxRates.updated.length}`);
  console.log(`Customers created/reused/updated: ${summary.customers.created.length}/${summary.customers.reused.length}/${summary.customers.updated.length}`);
  console.log(`Suppliers created/reused/updated: ${summary.suppliers.created.length}/${summary.suppliers.reused.length}/${summary.suppliers.updated.length}`);
  console.log(`Invoices created/reused: ${summary.invoices.created.length}/${summary.invoices.reused.length}`);
  console.log(`Bills created/reused: ${summary.bills.created.length}/${summary.bills.reused.length}`);
  console.log(`Manual journals created/reused: ${summary.journals.created.length}/${summary.journals.reused.length}`);
  console.log(`Users created/reused/skipped: ${summary.users.created.length}/${summary.users.reused.length}/${summary.users.skipped.length}`);
  console.log(`Products skipped: ${summary.products.skipped.join('; ') || 'none'}`);
  if (summary.warnings.length > 0 || summary.users.skipped.length > 0) {
    console.log('');
    console.log('Warnings/skipped:');
    for (const warning of summary.warnings) console.log(`  - ${warning}`);
    for (const skipped of summary.users.skipped) console.log(`  - ${skipped}`);
  }
  console.log('');
  console.log('Suggested UI pages to test:');
  console.log('  Dashboard, Chart of Accounts, Fiscal Periods, Customers, Suppliers');
  console.log('  Invoices, Bills, Journal Entries, Ledger');
  console.log('  Trial Balance, Income Statement, Balance Sheet, Cash Flow');
  console.log('  AR Aging, AP Aging, VAT Return, Multi-currency document views');
}

async function seedDemoData(options) {
  const tenant = await findTenant(options.tenantId);
  if (options.dryRun) {
    printDryRunPlan(tenant, options);
    return null;
  }

  const summary = createSummary();
  const tenantId = tenant._id;
  const baseCurrency = String(tenant.baseCurrency || 'SAR').toUpperCase();
  summary.tenant = {
    tenantId: tenantId.toString(),
    name: tenant.name,
    baseCurrency,
  };

  if (options.resetDemo) {
    await resetDemoData(tenantId, summary);
  }

  const actor = await ensureActorAndDemoUsers(tenantId, summary, options);
  await ensureFiscalPeriods(tenantId, actor._id, summary, options);
  const accounts = await ensureAccounts(tenantId, actor._id, summary);
  await ensureCurrencies(summary);
  await currencyService.requireActiveCurrency(baseCurrency);
  await ensureExchangeRates(tenantId, actor._id, baseCurrency, summary);
  const taxRates = await ensureTaxRates(tenantId, actor._id, summary);
  const { customers, suppliers } = await ensureParties(tenantId, actor._id, summary);

  summary.products.skipped.push('src/modules/product is not present; product/item seeding skipped');

  await ensureManualJournals(tenantId, actor._id, accounts, summary);
  await ensureInvoices(tenantId, actor._id, baseCurrency, accounts, taxRates, customers, summary);
  await ensureBills(tenantId, actor._id, baseCurrency, accounts, taxRates, suppliers, summary);

  printSummary(summary);
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  await connectDatabase();
  try {
    await seedDemoData(options);
  } finally {
    await disconnectDatabase();
    await disconnectRedis();
  }
}

main().catch((error) => {
  console.error('Demo seed failed.');
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
