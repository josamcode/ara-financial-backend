'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const currencyService = require('../src/modules/currency/currency.service');
const exchangeRateService = require('../src/modules/exchange-rate/exchange-rate.service');
const taxService = require('../src/modules/tax/tax.service');
const invoiceService = require('../src/modules/invoice/invoice.service');
const billService = require('../src/modules/bill/bill.service');
const {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
} = require('./helpers/integration');

const tenantIds = new Set();

test.before(async () => {
  await ensureDatabase();
  await currencyService.seedDefaultCurrencies();
});

test.after(async () => {
  await cleanupTenantData(tenantIds);
  await closeDatabase();
});

async function createFixture() {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);
  return fixture;
}

function baseInvoicePayload(overrides = {}) {
  return {
    customerName: 'Snapshot Customer',
    issueDate: '2026-04-01',
    dueDate: '2026-04-30',
    lineItems: [{
      description: 'Service',
      quantity: '1',
      unitPrice: '100',
      lineTotal: '100',
    }],
    subtotal: '100',
    total: '100',
    ...overrides,
  };
}

function baseBillPayload(overrides = {}) {
  return {
    supplierName: 'Snapshot Supplier',
    issueDate: '2026-04-01',
    dueDate: '2026-04-30',
    lineItems: [{
      description: 'Expense',
      quantity: '1',
      unitPrice: '100',
      lineTotal: '100',
    }],
    subtotal: '100',
    total: '100',
    ...overrides,
  };
}

async function createTaxRate(fixture, type = 'both') {
  return taxService.createTaxRate(
    fixture.tenant._id,
    fixture.user._id,
    {
      name: `${type} VAT 15%`,
      code: `${type.toUpperCase()}_VAT15`,
      rate: '15',
      type,
    }
  );
}

function assertExchangeRateRequired(promiseFactory) {
  return assert.rejects(promiseFactory, (error) => {
    assert.equal(error.code, 'EXCHANGE_RATE_REQUIRED');
    assert.equal(
      error.message,
      'Exchange rate is required when document currency differs from base currency'
    );
    return true;
  });
}

test('same-currency invoice stores snapshot and matching base totals', async () => {
  const fixture = await createFixture();

  const invoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    baseInvoicePayload({ documentCurrency: 'SAR' }),
    { auditContext: fixture.auditContext }
  );

  assert.equal(invoice.currency, 'SAR');
  assert.equal(invoice.documentCurrency, 'SAR');
  assert.equal(invoice.baseCurrency, 'SAR');
  assert.equal(invoice.exchangeRate.toString(), '1');
  assert.equal(invoice.baseSubtotal.toString(), invoice.subtotal.toString());
  assert.equal(invoice.baseTaxTotal.toString(), invoice.taxTotal.toString());
  assert.equal(invoice.baseTotal.toString(), invoice.total.toString());
  assert.equal(invoice.lineItems[0].lineBaseTotal.toString(), invoice.lineItems[0].lineTotal.toString());
});

test('foreign-currency taxed invoice stores approved snapshot and base totals', async () => {
  const fixture = await createFixture();
  const taxRate = await createTaxRate(fixture, 'sales');

  const invoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    baseInvoicePayload({
      documentCurrency: 'USD',
      exchangeRate: '3.75',
      exchangeRateDate: '2026-04-01',
      exchangeRateSource: 'manual',
      lineItems: [{
        description: 'Taxed service',
        quantity: '1',
        unitPrice: '100',
        taxRateId: taxRate._id.toString(),
        lineTotal: '100',
      }],
    }),
    { auditContext: fixture.auditContext }
  );

  assert.equal(invoice.documentCurrency, 'USD');
  assert.equal(invoice.currency, 'USD');
  assert.equal(invoice.baseCurrency, 'SAR');
  assert.equal(invoice.exchangeRate.toString(), '3.75');
  assert.equal(invoice.subtotal.toString(), '100');
  assert.equal(invoice.taxTotal.toString(), '15');
  assert.equal(invoice.total.toString(), '115');
  assert.equal(invoice.baseSubtotal.toString(), '375');
  assert.equal(invoice.baseTaxTotal.toString(), '56.25');
  assert.equal(invoice.baseTotal.toString(), '431.25');
  assert.equal(invoice.lineItems[0].lineBaseSubtotal.toString(), '375');
  assert.equal(invoice.lineItems[0].lineBaseTaxAmount.toString(), '56.25');
  assert.equal(invoice.lineItems[0].lineBaseTotal.toString(), '431.25');
});

test('foreign-currency invoice requires exchange rate', async () => {
  const fixture = await createFixture();

  await assertExchangeRateRequired(() => invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    baseInvoicePayload({ documentCurrency: 'USD' }),
    { auditContext: fixture.auditContext }
  ));
});

test('same-currency bill stores snapshot and matching base totals', async () => {
  const fixture = await createFixture();

  const bill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    baseBillPayload({ documentCurrency: 'SAR' }),
    { auditContext: fixture.auditContext }
  );

  assert.equal(bill.currency, 'SAR');
  assert.equal(bill.documentCurrency, 'SAR');
  assert.equal(bill.baseCurrency, 'SAR');
  assert.equal(bill.exchangeRate.toString(), '1');
  assert.equal(bill.baseSubtotal.toString(), bill.subtotal.toString());
  assert.equal(bill.baseTaxTotal.toString(), bill.taxTotal.toString());
  assert.equal(bill.baseTotal.toString(), bill.total.toString());
});

test('foreign-currency taxed bill stores approved snapshot and base totals', async () => {
  const fixture = await createFixture();
  const taxRate = await createTaxRate(fixture, 'purchase');

  const bill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    baseBillPayload({
      documentCurrency: 'USD',
      exchangeRate: '3.75',
      exchangeRateDate: '2026-04-01',
      exchangeRateSource: 'manual',
      lineItems: [{
        description: 'Taxed expense',
        quantity: '2',
        unitPrice: '100',
        taxRateId: taxRate._id.toString(),
        lineTotal: '200',
      }],
      subtotal: '200',
      total: '200',
    }),
    { auditContext: fixture.auditContext }
  );

  assert.equal(bill.documentCurrency, 'USD');
  assert.equal(bill.currency, 'USD');
  assert.equal(bill.baseCurrency, 'SAR');
  assert.equal(bill.subtotal.toString(), '200');
  assert.equal(bill.taxTotal.toString(), '30');
  assert.equal(bill.total.toString(), '230');
  assert.equal(bill.baseSubtotal.toString(), '750');
  assert.equal(bill.baseTaxTotal.toString(), '112.5');
  assert.equal(bill.baseTotal.toString(), '862.5');
});

test('foreign-currency bill requires exchange rate', async () => {
  const fixture = await createFixture();

  await assertExchangeRateRequired(() => billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    baseBillPayload({ documentCurrency: 'USD' }),
    { auditContext: fixture.auditContext }
  ));
});

test('exchange rate changes do not mutate existing document snapshots', async () => {
  const fixture = await createFixture();
  const storedRate = await exchangeRateService.createExchangeRate(
    fixture.tenant._id,
    fixture.user._id,
    {
      fromCurrency: 'USD',
      toCurrency: 'SAR',
      rate: '3.75',
      effectiveDate: '2026-04-01',
      source: 'company_rate',
    }
  );

  const invoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    baseInvoicePayload({
      documentCurrency: 'USD',
      exchangeRate: storedRate.rate.toString(),
      exchangeRateDate: storedRate.effectiveDate.toISOString(),
      exchangeRateSource: storedRate.source,
    }),
    { auditContext: fixture.auditContext }
  );

  await exchangeRateService.updateExchangeRate(
    fixture.tenant._id,
    storedRate._id,
    { rate: '4.25' }
  );

  const reloaded = await invoiceService.getInvoiceById(invoice._id, fixture.tenant._id);

  assert.equal(reloaded.exchangeRate.toString(), '3.75');
  assert.equal(reloaded.baseSubtotal.toString(), '375');
  assert.equal(reloaded.baseTotal.toString(), '375');
});

test('existing no-currency no-tax document payloads default to tenant base currency', async () => {
  const fixture = await createFixture();

  const invoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    baseInvoicePayload(),
    { auditContext: fixture.auditContext }
  );
  const bill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    baseBillPayload(),
    { auditContext: fixture.auditContext }
  );

  assert.equal(invoice.documentCurrency, 'SAR');
  assert.equal(invoice.exchangeRate.toString(), '1');
  assert.equal(invoice.baseTotal.toString(), invoice.total.toString());
  assert.equal(bill.documentCurrency, 'SAR');
  assert.equal(bill.exchangeRate.toString(), '1');
  assert.equal(bill.baseTotal.toString(), bill.total.toString());
});
