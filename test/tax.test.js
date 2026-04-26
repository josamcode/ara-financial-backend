'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const accountService = require('../src/modules/account/account.service');
const taxService = require('../src/modules/tax/tax.service');
const invoiceService = require('../src/modules/invoice/invoice.service');
const billService = require('../src/modules/bill/bill.service');
const reportService = require('../src/modules/report/report.service');
const { JournalEntry } = require('../src/modules/journal/journal.model');
const { toScaledInteger } = require('../src/common/utils/money');
const {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
  createServer,
  closeServer,
  fetchJson,
  getAccountsByCode,
} = require('./helpers/integration');

const tenantIds = new Set();
let serverContext;

test.before(async () => {
  await ensureDatabase();
  serverContext = await createServer();
});

test.after(async () => {
  await closeServer(serverContext?.server);
  await cleanupTenantData(tenantIds);
  await closeDatabase();
});

function authHeaders(fixture) {
  return {
    Authorization: `Bearer ${fixture.accessToken}`,
    'Content-Type': 'application/json',
  };
}

function assertBalanced(entry) {
  const totals = entry.lines.reduce((sum, line) => {
    sum.debit += toScaledInteger(line.debit.toString());
    sum.credit += toScaledInteger(line.credit.toString());
    return sum;
  }, { debit: 0n, credit: 0n });

  assert.equal(totals.debit, totals.credit);
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

test('tax rate CRUD routes are tenant scoped', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  const otherFixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);
  tenantIds.add(otherFixture.tenant._id);

  const createResult = await fetchJson(`${serverContext.baseUrl}/api/v1/tax-rates`, {
    method: 'POST',
    headers: authHeaders(fixture),
    body: JSON.stringify({
      name: 'VAT 15%',
      code: 'VAT15',
      rate: '15',
      type: 'both',
      description: 'Standard VAT',
    }),
  });

  assert.equal(createResult.response.status, 201);
  assert.equal(createResult.body.data.taxRate.rate, '15');
  const taxRateId = createResult.body.data.taxRate._id;

  const listResult = await fetchJson(`${serverContext.baseUrl}/api/v1/tax-rates`, {
    headers: { Authorization: `Bearer ${fixture.accessToken}` },
  });
  assert.equal(listResult.response.status, 200);
  assert.equal(listResult.body.meta.pagination.total, 1);

  const otherTenantResult = await fetchJson(`${serverContext.baseUrl}/api/v1/tax-rates/${taxRateId}`, {
    headers: { Authorization: `Bearer ${otherFixture.accessToken}` },
  });
  assert.equal(otherTenantResult.response.status, 404);

  const updateResult = await fetchJson(`${serverContext.baseUrl}/api/v1/tax-rates/${taxRateId}`, {
    method: 'PATCH',
    headers: authHeaders(fixture),
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(updateResult.response.status, 200);
  assert.equal(updateResult.body.data.taxRate.isActive, false);

  const inactiveList = await fetchJson(`${serverContext.baseUrl}/api/v1/tax-rates?isActive=false`, {
    headers: { Authorization: `Bearer ${fixture.accessToken}` },
  });
  assert.equal(inactiveList.response.status, 200);
  assert.equal(inactiveList.body.meta.pagination.total, 1);

  const deleteResult = await fetchJson(`${serverContext.baseUrl}/api/v1/tax-rates/${taxRateId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${fixture.accessToken}` },
  });
  assert.equal(deleteResult.response.status, 200);

  const deletedResult = await fetchJson(`${serverContext.baseUrl}/api/v1/tax-rates/${taxRateId}`, {
    headers: { Authorization: `Bearer ${fixture.accessToken}` },
  });
  assert.equal(deletedResult.response.status, 404);
});

test('taxed and no-tax invoices calculate totals and post balanced journals', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1120', '4100', '2140']);
  const arAccountId = accounts.get('1120')._id.toString();
  const revenueAccountId = accounts.get('4100')._id.toString();
  const outputVatAccountId = accounts.get('2140')._id.toString();
  const taxRate = await taxService.createTaxRate(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Sales VAT 15%', code: 'SALES15', rate: '15', type: 'sales' }
  );

  const invoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    {
      customerName: 'Tax Customer',
      issueDate: '2026-04-01',
      dueDate: '2026-04-30',
      lineItems: [{
        description: 'Service',
        quantity: '2',
        unitPrice: '50',
        taxRateId: taxRate._id.toString(),
        lineTotal: '100',
      }],
      subtotal: '100',
      total: '100',
    },
    { auditContext: fixture.auditContext }
  );

  assert.equal(invoice.subtotal.toString(), '100');
  assert.equal(invoice.taxTotal.toString(), '15');
  assert.equal(invoice.total.toString(), '115');
  assert.equal(invoice.lineItems[0].lineSubtotal.toString(), '100');
  assert.equal(invoice.lineItems[0].taxRate.toString(), '15');
  assert.equal(invoice.lineItems[0].taxAmount.toString(), '15');
  assert.equal(invoice.lineItems[0].lineTotal.toString(), '115');

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

  assert.equal(entry.lines.length, 3);
  assertBalanced(entry);
  assert.ok(entry.lines.some((line) => (
    line.accountId.toString() === outputVatAccountId &&
    line.credit.toString() === '15'
  )));

  const noTaxInvoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    {
      customerName: 'No Tax Customer',
      issueDate: '2026-04-02',
      dueDate: '2026-04-30',
      lineItems: [{
        description: 'Service',
        quantity: '1',
        unitPrice: '80',
        lineTotal: '80',
      }],
      subtotal: '80',
      total: '80',
    },
    { auditContext: fixture.auditContext }
  );

  assert.equal(noTaxInvoice.taxTotal.toString(), '0');
  const sentNoTaxInvoice = await invoiceService.markAsSent(
    noTaxInvoice._id,
    fixture.tenant._id,
    fixture.user._id,
    { arAccountId, revenueAccountId },
    { auditContext: fixture.auditContext }
  );
  const noTaxEntry = await JournalEntry.findOne({
    _id: sentNoTaxInvoice.sentJournalEntryId,
    tenantId: fixture.tenant._id,
  });
  assert.equal(noTaxEntry.lines.length, 2);
  assertBalanced(noTaxEntry);

  const purchaseRate = await taxService.createTaxRate(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Purchase VAT', code: 'PUR15INV', rate: '15', type: 'purchase' }
  );

  await assert.rejects(() => invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    {
      customerName: 'Invalid Tax Customer',
      issueDate: '2026-04-03',
      dueDate: '2026-04-30',
      lineItems: [{
        description: 'Service',
        quantity: '1',
        unitPrice: '100',
        taxRateId: purchaseRate._id.toString(),
        lineTotal: '100',
      }],
      subtotal: '100',
      total: '100',
    },
    { auditContext: fixture.auditContext }
  ), /not valid for this document/i);

  const trialBalance = await reportService.getTrialBalance(fixture.tenant._id, { refresh: true });
  assert.equal(trialBalance.totals.isBalanced, true);
});

test('taxed and no-tax bills calculate totals and post balanced journals', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const inputVatAccount = await createInputVatAccount(fixture);
  const accounts = await getAccountsByCode(fixture.tenant._id, ['2110', '5200']);
  const apAccountId = accounts.get('2110')._id.toString();
  const expenseAccountId = accounts.get('5200')._id.toString();
  const taxRate = await taxService.createTaxRate(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Purchase VAT 15%', code: 'PUR15', rate: '15', type: 'purchase' }
  );

  const bill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    {
      supplierName: 'Tax Supplier',
      issueDate: '2026-04-01',
      dueDate: '2026-04-30',
      lineItems: [{
        description: 'Expense',
        quantity: '1',
        unitPrice: '200',
        taxRateId: taxRate._id.toString(),
        lineTotal: '200',
      }],
      subtotal: '200',
      total: '200',
    },
    { auditContext: fixture.auditContext }
  );

  assert.equal(bill.subtotal.toString(), '200');
  assert.equal(bill.taxTotal.toString(), '30');
  assert.equal(bill.total.toString(), '230');
  assert.equal(bill.lineItems[0].taxAmount.toString(), '30');

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

  assert.equal(entry.lines.length, 3);
  assertBalanced(entry);
  assert.ok(entry.lines.some((line) => (
    line.accountId.toString() === inputVatAccount._id.toString() &&
    line.debit.toString() === '30'
  )));

  const noTaxBill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    {
      supplierName: 'No Tax Supplier',
      issueDate: '2026-04-02',
      dueDate: '2026-04-30',
      lineItems: [{
        description: 'Expense',
        quantity: '1',
        unitPrice: '75',
        lineTotal: '75',
      }],
      subtotal: '75',
      total: '75',
    },
    { auditContext: fixture.auditContext }
  );

  assert.equal(noTaxBill.taxTotal.toString(), '0');
  const postedNoTaxBill = await billService.postBill(
    noTaxBill._id,
    fixture.tenant._id,
    fixture.user._id,
    { apAccountId, debitAccountId: expenseAccountId },
    { auditContext: fixture.auditContext }
  );
  const noTaxEntry = await JournalEntry.findOne({
    _id: postedNoTaxBill.postedJournalEntryId,
    tenantId: fixture.tenant._id,
  });
  assert.equal(noTaxEntry.lines.length, 2);
  assertBalanced(noTaxEntry);

  const salesRate = await taxService.createTaxRate(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Sales VAT', code: 'SALES15BILL', rate: '15', type: 'sales' }
  );

  await assert.rejects(() => billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    {
      supplierName: 'Invalid Tax Supplier',
      issueDate: '2026-04-03',
      dueDate: '2026-04-30',
      lineItems: [{
        description: 'Expense',
        quantity: '1',
        unitPrice: '100',
        taxRateId: salesRate._id.toString(),
        lineTotal: '100',
      }],
      subtotal: '100',
      total: '100',
    },
    { auditContext: fixture.auditContext }
  ), /not valid for this document/i);

  const trialBalance = await reportService.getTrialBalance(fixture.tenant._id, { refresh: true });
  assert.equal(trialBalance.totals.isBalanced, true);
});
