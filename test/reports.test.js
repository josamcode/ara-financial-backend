'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reportService = require('../src/modules/report/report.service');
const fiscalPeriodService = require('../src/modules/fiscal-period/fiscalPeriod.service');
const customerService = require('../src/modules/customer/customer.service');
const invoiceService = require('../src/modules/invoice/invoice.service');
const {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
  createPostedEntry,
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

test('report routes return validation 4xx responses for missing required params', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/reports/income-statement`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  assert.equal(response.status, 422);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('balance sheet current-year earnings are limited to the fiscal year containing the as-of date', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2025 });
  tenantIds.add(fixture.tenant._id);

  await fiscalPeriodService.createFiscalYear(
    fixture.tenant._id,
    { year: 2026 },
    {
      userId: fixture.user._id,
      auditContext: fixture.auditContext,
    }
  );

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '4100']);

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2025, 2, 10)).toISOString(),
      description: 'Prior year revenue',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '1000.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '1000.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2026, 4, 10)).toISOString(),
      description: 'Current year revenue',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '300.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '300.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  const report = await reportService.getBalanceSheet(fixture.tenant._id, {
    asOfDate: new Date(Date.UTC(2026, 5, 30)).toISOString(),
  });

  const currentYearEarnings = report.equity.find((entry) => entry.code === '3300');

  assert.equal(currentYearEarnings?.balance, '300');
  assert.deepEqual(report.yearClose.pendingPriorYearClosures, [2025]);
});

test('cash flow reports support comparison and export formats', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '4100', '5200']);

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2026, 0, 10)).toISOString(),
      description: 'Comparison period revenue',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '100.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '100.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2026, 1, 10)).toISOString(),
      description: 'Primary period revenue',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '500.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '500.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2026, 1, 15)).toISOString(),
      description: 'Primary period salary',
      lines: [
        { accountId: accounts.get('5200')._id.toString(), debit: '200.00', credit: '0' },
        { accountId: accounts.get('1111')._id.toString(), debit: '0', credit: '200.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  const report = await reportService.getCashFlowStatement(fixture.tenant._id, {
    startDate: new Date(Date.UTC(2026, 1, 1)).toISOString(),
    endDate: new Date(Date.UTC(2026, 1, 28)).toISOString(),
    compareStartDate: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    compareEndDate: new Date(Date.UTC(2026, 0, 31)).toISOString(),
  });

  assert.equal(report.totals.netIncreaseInCash, '300');
  assert.equal(report.comparison?.totals?.netIncreaseInCash, '100');
  assert.equal(report.comparison?.delta?.netIncreaseInCash, '200');

  const excelResponse = await fetch(`${serverContext.baseUrl}/api/v1/reports/cash-flow/export?startDate=2026-02-01&endDate=2026-02-28&format=excel`, {
    headers: {
      Authorization: `Bearer ${fixture.accessToken}`,
    },
  });
  assert.equal(excelResponse.status, 200);
  assert.match(excelResponse.headers.get('content-type') || '', /application\/vnd\.ms-excel/i);

  const pdfResponse = await fetch(`${serverContext.baseUrl}/api/v1/reports/cash-flow/export?startDate=2026-02-01&endDate=2026-02-28&format=pdf`, {
    headers: {
      Authorization: `Bearer ${fixture.accessToken}`,
    },
  });
  assert.equal(pdfResponse.status, 200);
  assert.match(pdfResponse.headers.get('content-type') || '', /application\/pdf/i);
});

test('ar aging report groups outstanding balances by customer and aging bucket', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100']);
  const arAccountId = accounts.get('1120')._id.toString();
  const revenueAccountId = accounts.get('4100')._id.toString();
  const cashAccountId = accounts.get('1111')._id.toString();

  async function createSentInvoice(customer, { amount, issueDate, dueDate }) {
    const invoice = await invoiceService.createInvoice(
      fixture.tenant._id,
      fixture.user._id,
      {
        customerId: customer._id.toString(),
        customerName: customer.name,
        customerEmail: customer.email,
        issueDate,
        dueDate,
        currency: 'EGP',
        lineItems: [
          {
            description: 'Service line',
            quantity: '1',
            unitPrice: amount,
            lineTotal: amount,
          },
        ],
        subtotal: amount,
        total: amount,
        notes: '',
      },
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

  const customerA = await customerService.createCustomer(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Alpha Stores', email: 'alpha@example.com' },
    { auditContext: fixture.auditContext }
  );
  const customerB = await customerService.createCustomer(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Beta Supplies', email: 'beta@example.com' },
    { auditContext: fixture.auditContext }
  );

  const invoiceA1 = await createSentInvoice(customerA, {
    amount: '1000.00',
    issueDate: '2026-04-01',
    dueDate: '2026-04-10',
  });
  const invoiceA2 = await createSentInvoice(customerA, {
    amount: '500.00',
    issueDate: '2026-02-01',
    dueDate: '2026-02-15',
  });
  const invoiceB1 = await createSentInvoice(customerB, {
    amount: '400.00',
    issueDate: '2026-01-01',
    dueDate: '2026-01-15',
  });
  const invoiceB2 = await createSentInvoice(customerB, {
    amount: '200.00',
    issueDate: '2026-04-18',
    dueDate: '2026-04-30',
  });
  const invoiceExcluded = await createSentInvoice(customerB, {
    amount: '250.00',
    issueDate: '2026-03-01',
    dueDate: '2026-03-15',
  });

  await invoiceService.recordPayment(
    invoiceA2._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '200.00', paymentDate: '2026-03-01' },
    { auditContext: fixture.auditContext }
  );
  await invoiceService.recordPayment(
    invoiceExcluded._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '250.00', paymentDate: '2026-03-20' },
    { auditContext: fixture.auditContext }
  );

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/reports/ar-aging?asOfDate=2026-04-21`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.summary.totalOutstanding, '1900');
  assert.equal(body.data.summary.customersWithOutstanding, 2);
  assert.equal(body.data.summary.overdueInvoicesCount, 3);
  assert.match(body.data.asOfDate, /^2026-04-21T23:59:59\.999Z$/);

  const rowA = body.data.rows.find((row) => row.customerId === customerA._id.toString());
  const rowB = body.data.rows.find((row) => row.customerId === customerB._id.toString());

  assert.deepEqual(rowA, {
    customerId: customerA._id.toString(),
    customerName: 'Alpha Stores',
    days0_30: '1000',
    days31_60: '0',
    days61_90: '300',
    days90Plus: '0',
    totalOutstanding: '1300',
  });
  assert.deepEqual(rowB, {
    customerId: customerB._id.toString(),
    customerName: 'Beta Supplies',
    days0_30: '200',
    days31_60: '0',
    days61_90: '0',
    days90Plus: '400',
    totalOutstanding: '600',
  });

  const serviceReport = await reportService.getARAging(fixture.tenant._id, {
    asOfDate: '2026-04-21',
  });

  assert.equal(serviceReport.summary.totalOutstanding, '1900');
  assert.equal(serviceReport.rows.length, 2);

  assert.ok(invoiceA1);
  assert.ok(invoiceB1);
  assert.ok(invoiceB2);
});
