'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const accountService = require('../src/modules/account/account.service');
const currencyService = require('../src/modules/currency/currency.service');
const exchangeRateService = require('../src/modules/exchange-rate/exchange-rate.service');
const taxService = require('../src/modules/tax/tax.service');
const invoiceService = require('../src/modules/invoice/invoice.service');
const billService = require('../src/modules/bill/bill.service');
const customerService = require('../src/modules/customer/customer.service');
const supplierService = require('../src/modules/supplier/supplier.service');
const reportService = require('../src/modules/report/report.service');
const { Invoice } = require('../src/modules/invoice/invoice.model');
const { Bill } = require('../src/modules/bill/bill.model');
const { JournalEntry } = require('../src/modules/journal/journal.model');
const { toScaledInteger } = require('../src/common/utils/money');
const { calculateFxPayment } = require('../src/modules/currency/fx-payment');
const {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
  getAccountsByCode,
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

async function createInputVatAccount(fixture) {
  return accountService.createAccount(
    fixture.tenant._id,
    {
      code: '1150',
      nameAr: 'Input VAT',
      nameEn: 'Input VAT',
      type: 'asset',
    },
    {
      userId: fixture.user._id,
      auditContext: fixture.auditContext,
    }
  );
}

function assertBalanced(entry) {
  const totals = entry.lines.reduce((sum, line) => {
    sum.debit += toScaledInteger(line.debit.toString());
    sum.credit += toScaledInteger(line.credit.toString());
    return sum;
  }, { debit: 0n, credit: 0n });

  assert.equal(totals.debit, totals.credit);
}

function findLineByAccount(entry, accountId) {
  return entry.lines.find((line) => line.accountId.toString() === accountId);
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

function assertForeignPaymentUnsupported(promiseFactory) {
  return assert.rejects(promiseFactory, (error) => {
    assert.equal(error.code, 'FOREIGN_CURRENCY_PAYMENT_UNSUPPORTED');
    assert.equal(
      error.message,
      'Foreign-currency payments require FX gain/loss handling and are not supported in this version'
    );
    return true;
  });
}

test('FX payment helper calculates invoice-style gain/loss numbers', () => {
  const result = calculateFxPayment({
    documentAmount: '100',
    documentExchangeRate: '3.75',
    paymentExchangeRate: '3.80',
  });

  assert.deepEqual(result, {
    documentPaidAmount: '100',
    carryingBaseAmount: '375',
    paymentBaseAmount: '380',
    signedDifference: '5',
    fxGainLossAmount: '5',
    fxGainLossType: 'gain',
  });
});

test('FX payment helper supports final payment remainingBaseAmount override', () => {
  const result = calculateFxPayment({
    documentAmount: '100',
    documentExchangeRate: '3.75',
    paymentExchangeRate: '3.80',
    isFinalPayment: true,
    remainingBaseAmount: '374.99',
  });

  assert.equal(result.documentPaidAmount, '100');
  assert.equal(result.carryingBaseAmount, '374.99');
  assert.equal(result.paymentBaseAmount, '380');
  assert.equal(result.signedDifference, '5.01');
  assert.equal(result.fxGainLossAmount, '5.01');
  assert.equal(result.fxGainLossType, 'gain');
});

test('FX account resolver finds configured gain and loss accounts', async () => {
  const fixture = await createFixture();

  const gainAccount = await accountService.findFxGainAccount(fixture.tenant._id);
  const lossAccount = await accountService.findFxLossAccount(fixture.tenant._id);

  assert.equal(gainAccount.code, '4310');
  assert.equal(gainAccount.type, 'revenue');
  assert.equal(gainAccount.nature, 'credit');
  assert.equal(gainAccount.isActive, true);
  assert.equal(gainAccount.isParentOnly, false);
  assert.equal(lossAccount.code, '5910');
  assert.equal(lossAccount.type, 'expense');
  assert.equal(lossAccount.nature, 'debit');
  assert.equal(lossAccount.isActive, true);
  assert.equal(lossAccount.isParentOnly, false);
});

test('FX account resolver throws when gain or loss accounts are missing', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['4310', '5910']);

  await accountService.deleteAccount(accounts.get('4310')._id, fixture.tenant._id, {
    userId: fixture.user._id,
    auditContext: fixture.auditContext,
  });
  await accountService.deleteAccount(accounts.get('5910')._id, fixture.tenant._id, {
    userId: fixture.user._id,
    auditContext: fixture.auditContext,
  });

  await assert.rejects(() => accountService.findFxGainAccount(fixture.tenant._id), (error) => {
    assert.equal(error.code, 'FX_ACCOUNT_NOT_CONFIGURED');
    assert.equal(error.message, 'Foreign exchange gain/loss accounts are not configured');
    return true;
  });
  await assert.rejects(() => accountService.findFxLossAccount(fixture.tenant._id), (error) => {
    assert.equal(error.code, 'FX_ACCOUNT_NOT_CONFIGURED');
    assert.equal(error.message, 'Foreign exchange gain/loss accounts are not configured');
    return true;
  });
});

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

test('same-currency invoice posting remains compatible and uses matching base amounts', async () => {
  const fixture = await createFixture();
  const taxRate = await createTaxRate(fixture, 'sales');
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1120', '4100', '2140']);
  const arAccountId = accounts.get('1120')._id.toString();
  const revenueAccountId = accounts.get('4100')._id.toString();
  const outputVatAccountId = accounts.get('2140')._id.toString();

  const invoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    baseInvoicePayload({
      documentCurrency: 'SAR',
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

  const sentInvoice = await invoiceService.markAsSent(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    { arAccountId, revenueAccountId },
    { auditContext: fixture.auditContext }
  );
  const entry = await JournalEntry.findOne({
    _id: sentInvoice.sentJournalEntryId,
    tenantId: fixture.tenant._id,
  });

  assertBalanced(entry);
  assert.equal(findLineByAccount(entry, arAccountId).debit.toString(), '115');
  assert.equal(findLineByAccount(entry, revenueAccountId).credit.toString(), '100');
  assert.equal(findLineByAccount(entry, outputVatAccountId).credit.toString(), '15');
});

test('foreign-currency invoice posting writes base-currency journal amounts', async () => {
  const fixture = await createFixture();
  const taxRate = await createTaxRate(fixture, 'sales');
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1120', '4100', '2140']);
  const arAccountId = accounts.get('1120')._id.toString();
  const revenueAccountId = accounts.get('4100')._id.toString();
  const outputVatAccountId = accounts.get('2140')._id.toString();

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

  const sentInvoice = await invoiceService.markAsSent(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    { arAccountId, revenueAccountId },
    { auditContext: fixture.auditContext }
  );
  const entry = await JournalEntry.findOne({
    _id: sentInvoice.sentJournalEntryId,
    tenantId: fixture.tenant._id,
  });

  assertBalanced(entry);
  assert.equal(findLineByAccount(entry, arAccountId).debit.toString(), '431.25');
  assert.equal(findLineByAccount(entry, revenueAccountId).credit.toString(), '375');
  assert.equal(findLineByAccount(entry, outputVatAccountId).credit.toString(), '56.25');

  const trialBalance = await reportService.getTrialBalance(fixture.tenant._id, { refresh: true });
  assert.equal(trialBalance.totals.isBalanced, true);
});

test('same-currency bill posting remains compatible and uses matching base amounts', async () => {
  const fixture = await createFixture();
  const inputVatAccount = await createInputVatAccount(fixture);
  const taxRate = await createTaxRate(fixture, 'purchase');
  const accounts = await getAccountsByCode(fixture.tenant._id, ['2110', '5200']);
  const apAccountId = accounts.get('2110')._id.toString();
  const expenseAccountId = accounts.get('5200')._id.toString();

  const bill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    baseBillPayload({
      documentCurrency: 'SAR',
      lineItems: [{
        description: 'Taxed expense',
        quantity: '1',
        unitPrice: '100',
        taxRateId: taxRate._id.toString(),
        lineTotal: '100',
      }],
    }),
    { auditContext: fixture.auditContext }
  );

  const postedBill = await billService.postBill(
    bill._id,
    fixture.tenant._id,
    fixture.user._id,
    { apAccountId, debitAccountId: expenseAccountId },
    { auditContext: fixture.auditContext }
  );
  const entry = await JournalEntry.findOne({
    _id: postedBill.postedJournalEntryId,
    tenantId: fixture.tenant._id,
  });

  assertBalanced(entry);
  assert.equal(findLineByAccount(entry, expenseAccountId).debit.toString(), '100');
  assert.equal(findLineByAccount(entry, inputVatAccount._id.toString()).debit.toString(), '15');
  assert.equal(findLineByAccount(entry, apAccountId).credit.toString(), '115');
});

test('foreign-currency bill posting writes base-currency journal amounts', async () => {
  const fixture = await createFixture();
  const inputVatAccount = await createInputVatAccount(fixture);
  const taxRate = await createTaxRate(fixture, 'purchase');
  const accounts = await getAccountsByCode(fixture.tenant._id, ['2110', '5200']);
  const apAccountId = accounts.get('2110')._id.toString();
  const expenseAccountId = accounts.get('5200')._id.toString();

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
        quantity: '1',
        unitPrice: '100',
        taxRateId: taxRate._id.toString(),
        lineTotal: '100',
      }],
    }),
    { auditContext: fixture.auditContext }
  );

  const postedBill = await billService.postBill(
    bill._id,
    fixture.tenant._id,
    fixture.user._id,
    { apAccountId, debitAccountId: expenseAccountId },
    { auditContext: fixture.auditContext }
  );
  const entry = await JournalEntry.findOne({
    _id: postedBill.postedJournalEntryId,
    tenantId: fixture.tenant._id,
  });

  assertBalanced(entry);
  assert.equal(findLineByAccount(entry, expenseAccountId).debit.toString(), '375');
  assert.equal(findLineByAccount(entry, inputVatAccount._id.toString()).debit.toString(), '56.25');
  assert.equal(findLineByAccount(entry, apAccountId).credit.toString(), '431.25');

  const trialBalance = await reportService.getTrialBalance(fixture.tenant._id, { refresh: true });
  assert.equal(trialBalance.totals.isBalanced, true);
});

test('vat return uses base-currency amounts for foreign taxed documents', async () => {
  const fixture = await createFixture();
  const inputVatAccount = await createInputVatAccount(fixture);
  const salesTaxRate = await createTaxRate(fixture, 'sales');
  const purchaseTaxRate = await createTaxRate(fixture, 'purchase');
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1120', '4100', '2110', '5200']);
  const arAccountId = accounts.get('1120')._id.toString();
  const revenueAccountId = accounts.get('4100')._id.toString();
  const apAccountId = accounts.get('2110')._id.toString();
  const expenseAccountId = accounts.get('5200')._id.toString();

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
        taxRateId: salesTaxRate._id.toString(),
        lineTotal: '100',
      }],
    }),
    { auditContext: fixture.auditContext }
  );
  await invoiceService.markAsSent(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    { arAccountId, revenueAccountId },
    { auditContext: fixture.auditContext }
  );

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
        quantity: '1',
        unitPrice: '100',
        taxRateId: purchaseTaxRate._id.toString(),
        lineTotal: '100',
      }],
    }),
    { auditContext: fixture.auditContext }
  );
  await billService.postBill(
    bill._id,
    fixture.tenant._id,
    fixture.user._id,
    { apAccountId, debitAccountId: expenseAccountId },
    { auditContext: fixture.auditContext }
  );

  const report = await reportService.getVatReturn(fixture.tenant._id, {
    startDate: '2026-04-01',
    endDate: '2026-04-30',
    includeDetails: true,
    refresh: true,
  });

  assert.equal(report.currency, 'SAR');
  assert.equal(report.amountsIn, 'baseCurrency');
  assert.deepEqual(report.summary, {
    outputVAT: '56.25',
    inputVAT: '56.25',
    netVAT: '0',
    status: 'zero',
  });
  assert.equal(report.details.sales[0].taxableAmount, '375');
  assert.equal(report.details.sales[0].taxAmount, '56.25');
  assert.equal(report.details.sales[0].total, '431.25');
  assert.equal(report.details.purchases[0].taxableAmount, '375');
  assert.equal(report.details.purchases[0].taxAmount, '56.25');
  assert.equal(report.details.purchases[0].total, '431.25');
  assert.ok(inputVatAccount);

  const trialBalance = await reportService.getTrialBalance(fixture.tenant._id, { refresh: true });
  assert.equal(trialBalance.totals.isBalanced, true);
});

test('payment safety blocks foreign documents and keeps same-currency payments compatible', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100', '2110', '5200']);
  const cashAccountId = accounts.get('1111')._id.toString();
  const arAccountId = accounts.get('1120')._id.toString();
  const revenueAccountId = accounts.get('4100')._id.toString();
  const apAccountId = accounts.get('2110')._id.toString();
  const expenseAccountId = accounts.get('5200')._id.toString();

  const foreignInvoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    baseInvoicePayload({
      documentCurrency: 'USD',
      exchangeRate: '3.75',
      exchangeRateDate: '2026-04-01',
      exchangeRateSource: 'manual',
    }),
    { auditContext: fixture.auditContext }
  );
  await invoiceService.markAsSent(
    foreignInvoice._id,
    fixture.tenant._id,
    fixture.user._id,
    { arAccountId, revenueAccountId },
    { auditContext: fixture.auditContext }
  );

  await assertForeignPaymentUnsupported(() => invoiceService.recordPayment(
    foreignInvoice._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '100', paymentDate: '2026-04-10' },
    { auditContext: fixture.auditContext }
  ));

  const foreignBill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    baseBillPayload({
      documentCurrency: 'USD',
      exchangeRate: '3.75',
      exchangeRateDate: '2026-04-01',
      exchangeRateSource: 'manual',
    }),
    { auditContext: fixture.auditContext }
  );
  await billService.postBill(
    foreignBill._id,
    fixture.tenant._id,
    fixture.user._id,
    { apAccountId, debitAccountId: expenseAccountId },
    { auditContext: fixture.auditContext }
  );

  await assertForeignPaymentUnsupported(() => billService.recordPayment(
    foreignBill._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '100', paymentDate: '2026-04-10' },
    { auditContext: fixture.auditContext }
  ));

  const sameCurrencyInvoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    baseInvoicePayload({ documentCurrency: 'SAR' }),
    { auditContext: fixture.auditContext }
  );
  await invoiceService.markAsSent(
    sameCurrencyInvoice._id,
    fixture.tenant._id,
    fixture.user._id,
    { arAccountId, revenueAccountId },
    { auditContext: fixture.auditContext }
  );
  const paidInvoice = await invoiceService.recordPayment(
    sameCurrencyInvoice._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '100', paymentDate: '2026-04-10' },
    { auditContext: fixture.auditContext }
  );
  assert.equal(paidInvoice.status, 'paid');
  assert.equal(paidInvoice.remainingAmount, 0);
  const reloadedPaidInvoice = await Invoice.findOne({
    _id: paidInvoice._id,
    tenantId: fixture.tenant._id,
  });
  const invoicePayment = reloadedPaidInvoice.payments[0];
  assert.equal(reloadedPaidInvoice.paidBaseAmount, 100);
  assert.equal(reloadedPaidInvoice.remainingBaseAmount, 0);
  assert.equal(invoicePayment.amount, 100);
  assert.equal(invoicePayment.baseAmount, 100);
  assert.equal(invoicePayment.carryingBaseAmount, 100);
  assert.equal(invoicePayment.paymentCurrency, 'SAR');
  assert.equal(invoicePayment.paymentExchangeRate.toString(), '1');
  assert.equal(invoicePayment.paymentExchangeRateSource, 'company_rate');
  assert.equal(invoicePayment.fxGainLossAmount, 0);
  assert.equal(invoicePayment.fxGainLossType, 'none');

  const sameCurrencyBill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    baseBillPayload({ documentCurrency: 'SAR' }),
    { auditContext: fixture.auditContext }
  );
  await billService.postBill(
    sameCurrencyBill._id,
    fixture.tenant._id,
    fixture.user._id,
    { apAccountId, debitAccountId: expenseAccountId },
    { auditContext: fixture.auditContext }
  );
  const paidBill = await billService.recordPayment(
    sameCurrencyBill._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '100', paymentDate: '2026-04-10' },
    { auditContext: fixture.auditContext }
  );
  assert.equal(paidBill.status, 'paid');
  assert.equal(paidBill.remainingAmount, 0);
  const reloadedPaidBill = await Bill.findOne({
    _id: paidBill._id,
    tenantId: fixture.tenant._id,
  });
  const billPayment = reloadedPaidBill.payments[0];
  assert.equal(reloadedPaidBill.paidBaseAmount, 100);
  assert.equal(reloadedPaidBill.remainingBaseAmount, 0);
  assert.equal(billPayment.amount, 100);
  assert.equal(billPayment.baseAmount, 100);
  assert.equal(billPayment.carryingBaseAmount, 100);
  assert.equal(billPayment.paymentCurrency, 'SAR');
  assert.equal(billPayment.paymentExchangeRate.toString(), '1');
  assert.equal(billPayment.paymentExchangeRateSource, 'company_rate');
  assert.equal(billPayment.fxGainLossAmount, 0);
  assert.equal(billPayment.fxGainLossType, 'none');
});

test('aging reports and customer supplier summaries do not mix foreign document balances', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1120', '4100', '2110', '5200']);
  const arAccountId = accounts.get('1120')._id.toString();
  const revenueAccountId = accounts.get('4100')._id.toString();
  const apAccountId = accounts.get('2110')._id.toString();
  const expenseAccountId = accounts.get('5200')._id.toString();
  const customer = await customerService.createCustomer(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Mixed Currency Customer', email: 'mixed-customer@example.com' },
    { auditContext: fixture.auditContext }
  );
  const supplier = await supplierService.createSupplier(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Mixed Currency Supplier', email: 'mixed-supplier@example.com' },
    { auditContext: fixture.auditContext }
  );

  async function createSentInvoice(documentCurrency) {
    const invoice = await invoiceService.createInvoice(
      fixture.tenant._id,
      fixture.user._id,
      baseInvoicePayload({
        customerId: customer._id.toString(),
        customerName: customer.name,
        documentCurrency,
        exchangeRate: documentCurrency === 'USD' ? '3.75' : undefined,
        exchangeRateDate: documentCurrency === 'USD' ? '2026-04-01' : undefined,
        exchangeRateSource: documentCurrency === 'USD' ? 'manual' : undefined,
        dueDate: '2099-12-31',
      }),
      { auditContext: fixture.auditContext }
    );
    await invoiceService.markAsSent(
      invoice._id,
      fixture.tenant._id,
      fixture.user._id,
      { arAccountId, revenueAccountId },
      { auditContext: fixture.auditContext }
    );
    return invoiceService.getInvoiceById(invoice._id, fixture.tenant._id);
  }

  async function createPostedBill(documentCurrency) {
    const bill = await billService.createBill(
      fixture.tenant._id,
      fixture.user._id,
      baseBillPayload({
        supplierId: supplier._id.toString(),
        supplierName: supplier.name,
        documentCurrency,
        exchangeRate: documentCurrency === 'USD' ? '3.75' : undefined,
        exchangeRateDate: documentCurrency === 'USD' ? '2026-04-01' : undefined,
        exchangeRateSource: documentCurrency === 'USD' ? 'manual' : undefined,
        dueDate: '2099-12-31',
      }),
      { auditContext: fixture.auditContext }
    );
    await billService.postBill(
      bill._id,
      fixture.tenant._id,
      fixture.user._id,
      { apAccountId, debitAccountId: expenseAccountId },
      { auditContext: fixture.auditContext }
    );
    return billService.getBillById(bill._id, fixture.tenant._id);
  }

  const sameCurrencyInvoice = await createSentInvoice('SAR');
  const foreignInvoice = await createSentInvoice('USD');
  const sameCurrencyBill = await createPostedBill('SAR');
  const foreignBill = await createPostedBill('USD');

  const arAging = await reportService.getARAging(fixture.tenant._id, {
    asOfDate: '2026-04-15',
    refresh: true,
  });
  assert.equal(arAging.summary.totalOutstanding, '100');
  assert.equal(arAging.summary.excludedForeignDocumentsCount, 1);
  assert.equal(arAging.warnings[0].code, 'FOREIGN_CURRENCY_BALANCES_UNSUPPORTED');
  assert.equal(arAging.warnings[0].documents[0].invoiceId, foreignInvoice._id.toString());

  const apAging = await reportService.getAPAging(fixture.tenant._id, {
    asOfDate: '2026-04-15',
    refresh: true,
  });
  assert.equal(apAging.summary.totalOutstanding, '100');
  assert.equal(apAging.summary.excludedForeignDocumentsCount, 1);
  assert.equal(apAging.warnings[0].code, 'FOREIGN_CURRENCY_BALANCES_UNSUPPORTED');
  assert.equal(apAging.warnings[0].documents[0].billId, foreignBill._id.toString());

  const customerInvoices = await customerService.getCustomerInvoices(customer._id, fixture.tenant._id);
  assert.equal(customerInvoices.summary.totalInvoiced, 100);
  assert.equal(customerInvoices.summary.excludedForeignDocumentsCount, 1);
  assert.equal(customerInvoices.warnings[0].documents[0].invoiceId, foreignInvoice._id.toString());

  const customerStatement = await customerService.getCustomerStatement(customer._id, fixture.tenant._id);
  assert.equal(customerStatement.summary.outstandingBalance, 100);
  assert.equal(customerStatement.transactions.length, 1);
  assert.equal(customerStatement.transactions[0].invoiceId, sameCurrencyInvoice._id.toString());
  assert.equal(customerStatement.transactions[0].currency, 'SAR');

  const supplierBills = await supplierService.getSupplierBills(supplier._id, fixture.tenant._id);
  assert.equal(supplierBills.summary.totalBilled, 100);
  assert.equal(supplierBills.summary.excludedForeignDocumentsCount, 1);
  assert.equal(supplierBills.warnings[0].documents[0].billId, foreignBill._id.toString());

  const supplierStatement = await supplierService.getSupplierStatement(supplier._id, fixture.tenant._id);
  assert.equal(supplierStatement.summary.outstandingBalance, 100);
  assert.equal(supplierStatement.transactions.length, 1);
  assert.equal(supplierStatement.transactions[0].billId, sameCurrencyBill._id.toString());
  assert.equal(supplierStatement.transactions[0].currency, 'SAR');
});

test('foreign-currency documents without base amounts fail posting', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1120', '4100', '2110', '5200']);
  const arAccountId = accounts.get('1120')._id.toString();
  const revenueAccountId = accounts.get('4100')._id.toString();
  const apAccountId = accounts.get('2110')._id.toString();
  const expenseAccountId = accounts.get('5200')._id.toString();

  const invoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    baseInvoicePayload({
      documentCurrency: 'USD',
      exchangeRate: '3.75',
    }),
    { auditContext: fixture.auditContext }
  );
  const bill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    baseBillPayload({
      documentCurrency: 'USD',
      exchangeRate: '3.75',
    }),
    { auditContext: fixture.auditContext }
  );

  await Invoice.updateOne(
    { _id: invoice._id, tenantId: fixture.tenant._id },
    {
      $set: {
        baseSubtotal: '0',
        baseTaxTotal: '0',
        baseTotal: '0',
      },
      $unset: {
        exchangeRate: '',
        exchangeRateDate: '',
        exchangeRateSource: '',
      },
    }
  );
  await Bill.updateOne(
    { _id: bill._id, tenantId: fixture.tenant._id },
    {
      $set: {
        baseSubtotal: '0',
        baseTaxTotal: '0',
        baseTotal: '0',
      },
      $unset: {
        exchangeRate: '',
        exchangeRateDate: '',
        exchangeRateSource: '',
      },
    }
  );

  await assert.rejects(() => invoiceService.markAsSent(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    { arAccountId, revenueAccountId },
    { auditContext: fixture.auditContext }
  ), (error) => {
    assert.equal(error.code, 'BASE_AMOUNTS_REQUIRED');
    assert.equal(
      error.message,
      'Base currency amounts are required before posting foreign-currency documents'
    );
    return true;
  });

  await assert.rejects(() => billService.postBill(
    bill._id,
    fixture.tenant._id,
    fixture.user._id,
    { apAccountId, debitAccountId: expenseAccountId },
    { auditContext: fixture.auditContext }
  ), (error) => {
    assert.equal(error.code, 'BASE_AMOUNTS_REQUIRED');
    assert.equal(
      error.message,
      'Base currency amounts are required before posting foreign-currency documents'
    );
    return true;
  });
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
