'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reportService = require('../src/modules/report/report.service');
const fiscalPeriodService = require('../src/modules/fiscal-period/fiscalPeriod.service');
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

  assert.equal(currentYearEarnings?.balance, '300.00');
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

  assert.equal(report.totals.netIncreaseInCash, '300.00');
  assert.equal(report.comparison?.totals?.netIncreaseInCash, '100.00');
  assert.equal(report.comparison?.delta?.netIncreaseInCash, '200.00');

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
