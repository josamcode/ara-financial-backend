'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const accountService = require('../src/modules/account/account.service');
const billService = require('../src/modules/bill/bill.service');
const currencyService = require('../src/modules/currency/currency.service');
const { Bill } = require('../src/modules/bill/bill.model');
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

function baseBillPayload(overrides = {}) {
  return {
    supplierName: 'FX Supplier',
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

async function createPostedBill(fixture, accounts, overrides = {}) {
  const bill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    baseBillPayload(overrides),
    { auditContext: fixture.auditContext }
  );

  return billService.postBill(
    bill._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      apAccountId: accounts.get('2110')._id.toString(),
      debitAccountId: accounts.get('5200')._id.toString(),
    },
    { auditContext: fixture.auditContext }
  );
}

async function createPostedForeignBill(fixture, accounts, overrides = {}) {
  return createPostedBill(fixture, accounts, {
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

async function getPaymentEntry(bill, tenantId) {
  return JournalEntry.findOne({
    _id: bill.paymentJournalEntryId,
    tenantId,
  });
}

async function assertPaymentCurrencyMismatch(promiseFactory) {
  await assert.rejects(promiseFactory, (error) => {
    assert.equal(error.code, 'PAYMENT_CURRENCY_MISMATCH');
    assert.equal(error.message, 'Payment currency must match bill document currency');
    return true;
  });
}

test('same-currency bill payment still works without FX accounts', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200', '4310', '5910']);
  await accountService.deleteAccount(accounts.get('4310')._id, fixture.tenant._id, {
    userId: fixture.user._id,
    auditContext: fixture.auditContext,
  });
  await accountService.deleteAccount(accounts.get('5910')._id, fixture.tenant._id, {
    userId: fixture.user._id,
    auditContext: fixture.auditContext,
  });

  const bill = await createPostedBill(fixture, accounts, { documentCurrency: 'SAR' });
  const paidBill = await billService.recordPayment(
    bill._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      cashAccountId: accounts.get('1111')._id.toString(),
      amount: '100',
      paymentDate: '2026-04-10',
    },
    { auditContext: fixture.auditContext }
  );

  assert.equal(paidBill.status, 'paid');
  assert.equal(paidBill.paidAmount, 100);
  assert.equal(paidBill.remainingAmount, 0);
  assert.equal(paidBill.paidBaseAmount, 100);
  assert.equal(paidBill.remainingBaseAmount, 0);
  assert.equal(paidBill.payments[0].paymentCurrency, 'SAR');
  assert.equal(paidBill.payments[0].paymentExchangeRate.toString(), '1');
  assert.equal(paidBill.payments[0].fxGainLossType, 'none');
});

test('foreign bill partial payment with FX gain posts balanced base-currency journal', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200', '4310']);
  const bill = await createPostedForeignBill(fixture, accounts);

  const paidBill = await billService.recordPayment(
    bill._id,
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
  const entry = await getPaymentEntry(paidBill, fixture.tenant._id);
  const payment = paidBill.payments[0];

  assertBalanced(entry);
  assert.equal(paidBill.status, 'partially_paid');
  assert.equal(paidBill.paidAmount, 40);
  assert.equal(paidBill.remainingAmount, 60);
  assert.equal(paidBill.paidBaseAmount, 150);
  assert.equal(paidBill.remainingBaseAmount, 225);
  assert.equal(payment.amount, 40);
  assert.equal(payment.baseAmount, 148);
  assert.equal(payment.carryingBaseAmount, 150);
  assert.equal(payment.paymentCurrency, 'USD');
  assert.equal(payment.paymentExchangeRate.toString(), '3.70');
  assert.equal(payment.fxGainLossAmount, 2);
  assert.equal(payment.fxGainLossType, 'gain');
  assert.equal(findLineByAccount(entry, accounts.get('2110')._id.toString()).debit.toString(), '150');
  assert.equal(findLineByAccount(entry, accounts.get('1111')._id.toString()).credit.toString(), '148');
  assert.equal(findLineByAccount(entry, accounts.get('4310')._id.toString()).credit.toString(), '2');
});

test('foreign bill partial payment with FX loss posts balanced base-currency journal', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200', '5910']);
  const bill = await createPostedForeignBill(fixture, accounts);

  const paidBill = await billService.recordPayment(
    bill._id,
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
  const entry = await getPaymentEntry(paidBill, fixture.tenant._id);
  const payment = paidBill.payments[0];

  assertBalanced(entry);
  assert.equal(payment.baseAmount, 152);
  assert.equal(payment.carryingBaseAmount, 150);
  assert.equal(payment.fxGainLossAmount, 2);
  assert.equal(payment.fxGainLossType, 'loss');
  assert.equal(findLineByAccount(entry, accounts.get('2110')._id.toString()).debit.toString(), '150');
  assert.equal(findLineByAccount(entry, accounts.get('5910')._id.toString()).debit.toString(), '2');
  assert.equal(findLineByAccount(entry, accounts.get('1111')._id.toString()).credit.toString(), '152');
});

test('foreign bill final payment clears remaining base amount', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200', '5910']);
  const bill = await createPostedForeignBill(fixture, accounts);

  await billService.recordPayment(
    bill._id,
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

  const paidBill = await billService.recordPayment(
    bill._id,
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
  const finalPayment = paidBill.payments[1];
  const entry = await getPaymentEntry(paidBill, fixture.tenant._id);

  assertBalanced(entry);
  assert.equal(paidBill.status, 'paid');
  assert.equal(paidBill.paidAmount, 100);
  assert.equal(paidBill.remainingAmount, 0);
  assert.equal(paidBill.paidBaseAmount, 375);
  assert.equal(paidBill.remainingBaseAmount, 0);
  assert.equal(finalPayment.carryingBaseAmount, 250.0125);
  assert.equal(finalPayment.baseAmount, 253.346);
  assert.equal(finalPayment.fxGainLossType, 'loss');
});

test('foreign bill payment rejects missing payment exchange rate', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200']);
  const bill = await createPostedForeignBill(fixture, accounts);

  await assert.rejects(() => billService.recordPayment(
    bill._id,
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
    assert.equal(error.message, 'Payment exchange rate is required for foreign-currency bill payments');
    return true;
  });
});

test('foreign bill payment rejects invalid payment exchange rate', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200']);
  const bill = await createPostedForeignBill(fixture, accounts);

  await assert.rejects(() => billService.recordPayment(
    bill._id,
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

test('foreign bill payment rejects payment currency mismatch', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200']);
  const bill = await createPostedForeignBill(fixture, accounts);

  await assertPaymentCurrencyMismatch(() => billService.recordPayment(
    bill._id,
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

test('USD bill paid in EUR is rejected', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200']);
  const bill = await createPostedForeignBill(fixture, accounts);

  await assertPaymentCurrencyMismatch(() => billService.recordPayment(
    bill._id,
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

test('USD bill paid in SAR is rejected when bill currency is USD', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200']);
  const bill = await createPostedForeignBill(fixture, accounts);

  await assertPaymentCurrencyMismatch(() => billService.recordPayment(
    bill._id,
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

test('foreign bill payment rejects missing FX Gain account when gain is needed', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200', '4310']);
  const bill = await createPostedForeignBill(fixture, accounts);
  await accountService.deleteAccount(accounts.get('4310')._id, fixture.tenant._id, {
    userId: fixture.user._id,
    auditContext: fixture.auditContext,
  });

  await assert.rejects(() => billService.recordPayment(
    bill._id,
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

test('foreign bill payment rejects missing FX Loss account when loss is needed', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200', '5910']);
  const bill = await createPostedForeignBill(fixture, accounts);
  await accountService.deleteAccount(accounts.get('5910')._id, fixture.tenant._id, {
    userId: fixture.user._id,
    auditContext: fixture.auditContext,
  });

  await assert.rejects(() => billService.recordPayment(
    bill._id,
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

test('foreign bill payment defaults omitted payment currency to document currency', async () => {
  const fixture = await createFixture();
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200', '4310']);
  const bill = await createPostedForeignBill(fixture, accounts);

  const paidBill = await billService.recordPayment(
    bill._id,
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
  const reloaded = await Bill.findOne({ _id: paidBill._id, tenantId: fixture.tenant._id });

  assert.equal(reloaded.payments[0].paymentCurrency, 'USD');
});
