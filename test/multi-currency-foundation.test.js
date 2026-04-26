'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const currencyService = require('../src/modules/currency/currency.service');
const { Currency } = require('../src/modules/currency/currency.model');
const { ExchangeRate } = require('../src/modules/exchange-rate/exchange-rate.model');
const { JournalEntry } = require('../src/modules/journal/journal.model');
const { Invoice } = require('../src/modules/invoice/invoice.model');
const { Bill } = require('../src/modules/bill/bill.model');
const Tenant = require('../src/modules/tenant/tenant.model');
const {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
  createServer,
  closeServer,
  fetchJson,
} = require('./helpers/integration');

const tenantIds = new Set();
let serverContext;

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function decimal(value) {
  return mongoose.Types.Decimal128.fromString(String(value));
}

async function postJson(path, token, body) {
  return fetchJson(`${serverContext.baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function patchJson(path, token, body) {
  return fetchJson(`${serverContext.baseUrl}${path}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function createMinimalFixture() {
  const fixture = await createTenantFixture({
    applyTemplate: false,
    createFiscalYear: false,
    createSubscription: false,
  });
  tenantIds.add(fixture.tenant._id);
  return fixture;
}

async function createJournalActivity(fixture) {
  return JournalEntry.create({
    tenantId: fixture.tenant._id,
    entryNumber: 900001,
    date: new Date(),
    description: 'Base currency lock activity',
    status: 'draft',
    lines: [
      {
        accountId: new mongoose.Types.ObjectId(),
        debit: decimal('10'),
        credit: decimal('0'),
        lineOrder: 1,
      },
      {
        accountId: new mongoose.Types.ObjectId(),
        debit: decimal('0'),
        credit: decimal('10'),
        lineOrder: 2,
      },
    ],
    createdBy: fixture.user._id,
  });
}

async function createInvoiceActivity(fixture) {
  const now = new Date();
  return Invoice.create({
    tenantId: fixture.tenant._id,
    invoiceNumber: `LOCK-INV-${Date.now()}`,
    customerName: 'Lock Customer',
    issueDate: now,
    dueDate: now,
    currency: 'SAR',
    lineItems: [
      {
        description: 'Lock line',
        quantity: decimal('1'),
        unitPrice: decimal('10'),
        lineSubtotal: decimal('10'),
        taxAmount: decimal('0'),
        lineTotal: decimal('10'),
      },
    ],
    subtotal: decimal('10'),
    total: decimal('10'),
    createdBy: fixture.user._id,
  });
}

async function createBillActivity(fixture) {
  const now = new Date();
  return Bill.create({
    tenantId: fixture.tenant._id,
    billNumber: `LOCK-BILL-${Date.now()}`,
    supplierName: 'Lock Supplier',
    issueDate: now,
    dueDate: now,
    currency: 'SAR',
    lineItems: [
      {
        description: 'Lock line',
        quantity: decimal('1'),
        unitPrice: decimal('10'),
        lineSubtotal: decimal('10'),
        taxAmount: decimal('0'),
        lineTotal: decimal('10'),
      },
    ],
    subtotal: decimal('10'),
    total: decimal('10'),
    createdBy: fixture.user._id,
  });
}

test.before(async () => {
  await ensureDatabase();
  await Currency.deleteMany({ code: { $in: ['SAR', 'USD', 'EGP', 'EUR', 'ABC', 'ZZZ'] } });
  await currencyService.seedDefaultCurrencies();
  serverContext = await createServer();
});

test.after(async () => {
  await closeServer(serverContext?.server);
  await cleanupTenantData(tenantIds);
  await Currency.deleteMany({ code: { $in: ['ABC', 'ZZZ'] } });
  await closeDatabase();
});

test('currency seed is idempotent and marks SAR as default', async () => {
  const before = await Currency.countDocuments({
    code: { $in: ['SAR', 'USD', 'EGP', 'EUR'] },
  });

  const first = await currencyService.seedDefaultCurrencies();
  const second = await currencyService.seedDefaultCurrencies();

  const currencies = await Currency.find({
    code: { $in: ['SAR', 'USD', 'EGP', 'EUR'] },
  }).lean();
  const defaults = currencies.filter((currency) => currency.isDefault);

  assert.equal(before, 4);
  assert.equal(first.inserted, 0);
  assert.equal(second.inserted, 0);
  assert.equal(currencies.length, 4);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].code, 'SAR');
});

test('GET /currencies returns SAR', async () => {
  const fixture = await createMinimalFixture();

  const { response, body } = await fetchJson(`${serverContext.baseUrl}/api/v1/currencies`, {
    headers: {
      Authorization: `Bearer ${fixture.accessToken}`,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data.currencies.some((currency) => (
    currency.code === 'SAR' &&
    currency.name === 'Saudi Riyal' &&
    currency.isDefault === true
  )));
});

test('new tenants default to SAR base currency', async () => {
  const fixture = await createMinimalFixture();
  const tenant = await Tenant.findById(fixture.tenant._id).lean();

  assert.equal(tenant.baseCurrency, 'SAR');
});

test('tenant baseCurrency can change before accounting activity exists', async () => {
  const fixture = await createMinimalFixture();

  const { response, body } = await patchJson(
    '/api/v1/tenants/base-currency',
    fixture.accessToken,
    { baseCurrency: 'USD' }
  );
  const tenant = await Tenant.findById(fixture.tenant._id).lean();

  assert.equal(response.status, 200);
  assert.equal(body.data.tenant.baseCurrency, 'USD');
  assert.equal(tenant.baseCurrency, 'USD');
});

test('tenant baseCurrency cannot change after journal, invoice, or bill activity exists', async () => {
  const activityFactories = [
    createJournalActivity,
    createInvoiceActivity,
    createBillActivity,
  ];

  for (const createActivity of activityFactories) {
    const fixture = await createMinimalFixture();
    await createActivity(fixture);

    const { response, body } = await patchJson(
      '/api/v1/tenants/base-currency',
      fixture.accessToken,
      { baseCurrency: 'USD' }
    );

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'BASE_CURRENCY_LOCKED');
  }
});

test('exchange rate can be created tenant-scoped', async () => {
  const fixture = await createMinimalFixture();

  const { response, body } = await postJson(
    '/api/v1/exchange-rates',
    fixture.accessToken,
    {
      fromCurrency: 'USD',
      toCurrency: 'SAR',
      rate: '3.750000',
      effectiveDate: '2026-04-01',
      source: 'manual',
      notes: 'Approved company rate',
    }
  );

  assert.equal(response.status, 201);
  assert.equal(body.data.exchangeRate.tenantId, fixture.tenant._id.toString());
  assert.equal(body.data.exchangeRate.fromCurrency, 'USD');
  assert.equal(body.data.exchangeRate.toCurrency, 'SAR');
  assert.equal(body.data.exchangeRate.rate, '3.750000');
});

test('latest exchange rate returns newest active rate on or before requested date', async () => {
  const fixture = await createMinimalFixture();

  await postJson('/api/v1/exchange-rates', fixture.accessToken, {
    fromCurrency: 'USD',
    toCurrency: 'SAR',
    rate: '3.700000',
    effectiveDate: '2026-01-01',
    source: 'manual',
  });
  await postJson('/api/v1/exchange-rates', fixture.accessToken, {
    fromCurrency: 'USD',
    toCurrency: 'SAR',
    rate: '3.750000',
    effectiveDate: '2026-04-01',
    source: 'manual',
  });
  await postJson('/api/v1/exchange-rates', fixture.accessToken, {
    fromCurrency: 'USD',
    toCurrency: 'SAR',
    rate: '3.800000',
    effectiveDate: '2026-05-01',
    source: 'manual',
  });

  const latest = await fetchJson(
    `${serverContext.baseUrl}/api/v1/exchange-rates/latest?from=USD&to=SAR&date=2026-04-26`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );
  const earlier = await fetchJson(
    `${serverContext.baseUrl}/api/v1/exchange-rates/latest?from=USD&to=SAR&date=2026-03-01`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  assert.equal(latest.response.status, 200);
  assert.equal(latest.body.data.exchangeRate.rate, '3.750000');
  assert.equal(earlier.response.status, 200);
  assert.equal(earlier.body.data.exchangeRate.rate, '3.700000');
});

test('exchange rates are isolated per tenant', async () => {
  const tenantA = await createMinimalFixture();
  const tenantB = await createMinimalFixture();

  await postJson('/api/v1/exchange-rates', tenantA.accessToken, {
    fromCurrency: 'EUR',
    toCurrency: 'SAR',
    rate: '4.100000',
    effectiveDate: '2026-04-01',
    source: 'manual',
  });
  await postJson('/api/v1/exchange-rates', tenantB.accessToken, {
    fromCurrency: 'EUR',
    toCurrency: 'SAR',
    rate: '9.900000',
    effectiveDate: '2026-04-01',
    source: 'manual',
  });

  const latestA = await fetchJson(
    `${serverContext.baseUrl}/api/v1/exchange-rates/latest?from=EUR&to=SAR&date=2026-04-26`,
    {
      headers: {
        Authorization: `Bearer ${tenantA.accessToken}`,
      },
    }
  );
  const storedForA = await ExchangeRate.find({ tenantId: tenantA.tenant._id }).lean();

  assert.equal(latestA.response.status, 200);
  assert.equal(latestA.body.data.exchangeRate.rate, '4.100000');
  assert.equal(storedForA.length, 1);
  assert.ok(storedForA.every((rate) => rate.tenantId.toString() === tenantA.tenant._id.toString()));
});

test('invalid and inactive currency codes are rejected for exchange rates', async () => {
  const fixture = await createMinimalFixture();

  await Currency.create({
    code: 'ZZZ',
    name: 'Inactive Test Currency',
    symbol: 'ZZZ',
    isActive: false,
  });

  const invalidSyntax = await postJson('/api/v1/exchange-rates', fixture.accessToken, {
    fromCurrency: 'US',
    toCurrency: 'SAR',
    rate: '3.750000',
    effectiveDate: '2026-04-01',
    source: 'manual',
  });
  const inactive = await postJson('/api/v1/exchange-rates', fixture.accessToken, {
    fromCurrency: 'ZZZ',
    toCurrency: 'SAR',
    rate: '3.750000',
    effectiveDate: '2026-04-01',
    source: 'manual',
  });

  assert.equal(invalidSyntax.response.status, 422);
  assert.equal(inactive.response.status, 400);
  assert.equal(inactive.body.error.code, 'CURRENCY_INACTIVE');
});
