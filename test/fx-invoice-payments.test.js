'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const accountService = require('../src/modules/account/account.service');
const currencyService = require('../src/modules/currency/currency.service');
const invoiceService = require('../src/modules/invoice/invoice.service');
const { Invoice } = require('../src/modules/invoice/invoice.model');
const { JournalEntry } = require('../src/modules/journal/journal.model');
const { toScaledInteger } = require('../src/common/utils/money');
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
    customerName: 'FX Customer',
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

async function createSentInvoice(fixture, accounts, overrides = {}) {
  const invoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    baseInvoicePayload(overrides),
    { auditContext: fixture.auditContext }
  );

  return invoiceService.markAsSent(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      arAccountId: accounts.get('1120')._id.toString(),
      revenueAccountId: accounts.get('4100')._id.toString(),
    },
    { auditContext: fixture.auditContext }
  );
}

async function createSentForeignInvoice(fixture, accounts, overrides = {}) {
  return createSentInvoice(fixture, accounts, {
    documentCurrency: 'USD',
    exchangeRate: '3.75',
    exchangeRateDate: '2026-04-01',
    exchangeRateSource: 'manual',
    ...overrides,
  });
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

async function getPaymentEntry(invoice, tenantId) {
  return JournalEntry.findOne({
    _id: invoice.paymentJournalEntryId,
    tenantId,
  });
}

async function assertPaymentCurrencyMismatch(promiseFactory) {
  await assert.rejects(promiseFactory, (error) => {
    assert.equal(error.code, 'PAYMENT_CURRENCY_MISMATCH');
    assert.equal(error.message, 'Payment currency must match invoice document currency');
    return true;
  });
}

test('same-currency invoice payment still works without FX accounts', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100', '4310', '5910']);
  await accountService.deleteAccount(accounts.get('4310')._id, fixture.tenant._id, {
    userId: fixture.user._id,
    auditContext: fixture.auditContext,
  });
  await accountService.deleteAccount(accounts.get('5910')._id, fixture.tenant._id, {
    userId: fixture.user._id,
    auditContext: fixture.auditContext,
  });

  const invoice = await createSentInvoice(fixture, accounts, { documentCurrency: 'SAR' });
  const paidInvoice = await invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '100',
      paymentDate: '2026-04-10',
    },
    { auditContext: fixture.auditContext }
  );

  assert.equal(paidInvoice.status, 'paid');
  assert.equal(paidInvoice.paidAmount, 100);
  assert.equal(paidInvoice.remainingAmount, 0);
  assert.equal(paidInvoice.paidBaseAmount, 100);
  assert.equal(paidInvoice.remainingBaseAmount, 0);
  assert.equal(paidInvoice.payments[0].paymentCurrency, 'SAR');
  assert.equal(paidInvoice.payments[0].paymentExchangeRate.toString(), '1');
  assert.equal(paidInvoice.payments[0].fxGainLossType, 'none');
});

test('foreign invoice partial payment with FX gain posts balanced base-currency journal', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100', '4310']);
  const invoice = await createSentForeignInvoice(fixture, accounts);

  const paidInvoice = await invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '40',
      paymentDate: '2026-04-10',
      paymentExchangeRate: '3.80',
    },
    { auditContext: fixture.auditContext }
  );
  const entry = await getPaymentEntry(paidInvoice, fixture.tenant._id);
  const payment = paidInvoice.payments[0];

  assertBalanced(entry);
  assert.equal(paidInvoice.status, 'partially_paid');
  assert.equal(paidInvoice.paidAmount, 40);
  assert.equal(paidInvoice.remainingAmount, 60);
  assert.equal(paidInvoice.paidBaseAmount, 150);
  assert.equal(paidInvoice.remainingBaseAmount, 225);
  assert.equal(payment.amount, 40);
  assert.equal(payment.baseAmount, 152);
  assert.equal(payment.carryingBaseAmount, 150);
  assert.equal(payment.paymentCurrency, 'USD');
  assert.equal(payment.paymentExchangeRate.toString(), '3.80');
  assert.equal(payment.fxGainLossAmount, 2);
  assert.equal(payment.fxGainLossType, 'gain');
  assert.equal(findLineByAccount(entry, accounts.get('1111')._id.toString()).debit.toString(), '152');
  assert.equal(findLineByAccount(entry, accounts.get('1120')._id.toString()).credit.toString(), '150');
  assert.equal(findLineByAccount(entry, accounts.get('4310')._id.toString()).credit.toString(), '2');
});

test('foreign invoice partial payment with FX loss posts balanced base-currency journal', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100', '5910']);
  const invoice = await createSentForeignInvoice(fixture, accounts);

  const paidInvoice = await invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '40',
      paymentDate: '2026-04-10',
      paymentExchangeRate: '3.70',
    },
    { auditContext: fixture.auditContext }
  );
  const entry = await getPaymentEntry(paidInvoice, fixture.tenant._id);
  const payment = paidInvoice.payments[0];

  assertBalanced(entry);
  assert.equal(payment.baseAmount, 148);
  assert.equal(payment.carryingBaseAmount, 150);
  assert.equal(payment.fxGainLossAmount, 2);
  assert.equal(payment.fxGainLossType, 'loss');
  assert.equal(findLineByAccount(entry, accounts.get('1111')._id.toString()).debit.toString(), '148');
  assert.equal(findLineByAccount(entry, accounts.get('5910')._id.toString()).debit.toString(), '2');
  assert.equal(findLineByAccount(entry, accounts.get('1120')._id.toString()).credit.toString(), '150');
});

test('foreign invoice final payment clears remaining base amount', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100', '4310']);
  const invoice = await createSentForeignInvoice(fixture, accounts);

  await invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '33.33',
      paymentDate: '2026-04-10',
      paymentExchangeRate: '3.80',
    },
    { auditContext: fixture.auditContext }
  );

  const paidInvoice = await invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '66.67',
      paymentDate: '2026-04-11',
      paymentExchangeRate: '3.80',
    },
    { auditContext: fixture.auditContext }
  );
  const finalPayment = paidInvoice.payments[1];
  const entry = await getPaymentEntry(paidInvoice, fixture.tenant._id);

  assertBalanced(entry);
  assert.equal(paidInvoice.status, 'paid');
  assert.equal(paidInvoice.paidAmount, 100);
  assert.equal(paidInvoice.remainingAmount, 0);
  assert.equal(paidInvoice.paidBaseAmount, 375);
  assert.equal(paidInvoice.remainingBaseAmount, 0);
  assert.equal(finalPayment.carryingBaseAmount, 250.0125);
  assert.equal(finalPayment.baseAmount, 253.346);
});

test('foreign invoice payment rejects missing payment exchange rate', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100']);
  const invoice = await createSentForeignInvoice(fixture, accounts);

  await assert.rejects(() => invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '40',
      paymentDate: '2026-04-10',
    },
    { auditContext: fixture.auditContext }
  ), (error) => {
    assert.equal(error.code, 'PAYMENT_EXCHANGE_RATE_REQUIRED');
    assert.equal(error.message, 'Payment exchange rate is required for foreign-currency invoice payments');
    return true;
  });
});

test('foreign invoice payment rejects invalid payment exchange rate', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100']);
  const invoice = await createSentForeignInvoice(fixture, accounts);

  await assert.rejects(() => invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '40',
      paymentDate: '2026-04-10',
      paymentExchangeRate: '0',
    },
    { auditContext: fixture.auditContext }
  ), (error) => {
    assert.equal(error.code, 'BAD_REQUEST');
    assert.equal(error.message, 'Payment exchange rate must be greater than zero');
    return true;
  });
});

test('foreign invoice payment rejects payment currency mismatch', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100']);
  const invoice = await createSentForeignInvoice(fixture, accounts);

  await assertPaymentCurrencyMismatch(() => invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '40',
      paymentDate: '2026-04-10',
      paymentCurrency: 'EUR',
      paymentExchangeRate: '3.80',
    },
    { auditContext: fixture.auditContext }
  ));
});

test('USD invoice paid in EUR is rejected', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100']);
  const invoice = await createSentForeignInvoice(fixture, accounts);

  await assertPaymentCurrencyMismatch(() => invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '40',
      paymentDate: '2026-04-10',
      paymentCurrency: 'EUR',
      paymentExchangeRate: '3.80',
    },
    { auditContext: fixture.auditContext }
  ));
});

test('USD invoice paid in SAR is rejected when invoice currency is USD', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100']);
  const invoice = await createSentForeignInvoice(fixture, accounts);

  await assertPaymentCurrencyMismatch(() => invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '40',
      paymentDate: '2026-04-10',
      paymentCurrency: 'SAR',
      paymentExchangeRate: '3.80',
    },
    { auditContext: fixture.auditContext }
  ));
});

test('foreign invoice payment rejects missing FX Gain account when gain is needed', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100', '4310']);
  const invoice = await createSentForeignInvoice(fixture, accounts);
  await accountService.deleteAccount(accounts.get('4310')._id, fixture.tenant._id, {
    userId: fixture.user._id,
    auditContext: fixture.auditContext,
  });

  await assert.rejects(() => invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '40',
      paymentDate: '2026-04-10',
      paymentExchangeRate: '3.80',
    },
    { auditContext: fixture.auditContext }
  ), (error) => {
    assert.equal(error.code, 'FX_ACCOUNT_NOT_CONFIGURED');
    assert.equal(error.message, 'Foreign exchange gain/loss accounts are not configured');
    return true;
  });
});

test('foreign invoice payment rejects missing FX Loss account when loss is needed', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100', '5910']);
  const invoice = await createSentForeignInvoice(fixture, accounts);
  await accountService.deleteAccount(accounts.get('5910')._id, fixture.tenant._id, {
    userId: fixture.user._id,
    auditContext: fixture.auditContext,
  });

  await assert.rejects(() => invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '40',
      paymentDate: '2026-04-10',
      paymentExchangeRate: '3.70',
    },
    { auditContext: fixture.auditContext }
  ), (error) => {
    assert.equal(error.code, 'FX_ACCOUNT_NOT_CONFIGURED');
    assert.equal(error.message, 'Foreign exchange gain/loss accounts are not configured');
    return true;
  });
});

test('foreign invoice payment defaults omitted payment currency to document currency', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100', '4310']);
  const invoice = await createSentForeignInvoice(fixture, accounts);

  const paidInvoice = await invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '40',
      paymentDate: '2026-04-10',
      paymentExchangeRate: '3.80',
    },
    { auditContext: fixture.auditContext }
  );
  const reloaded = await Invoice.findOne({ _id: paidInvoice._id, tenantId: fixture.tenant._id });

  assert.equal(reloaded.payments[0].paymentCurrency, 'USD');
});
