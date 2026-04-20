'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const journalService = require('../src/modules/journal/journal.service');
const dashboardService = require('../src/modules/dashboard/dashboard.service');
const fiscalPeriodService = require('../src/modules/fiscal-period/fiscalPeriod.service');
const {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
  getAccountsByCode,
  createPostedEntry,
} = require('./helpers/integration');

const tenantIds = new Set();

test.before(async () => {
  await ensureDatabase();
});

test.after(async () => {
  await cleanupTenantData(tenantIds);
  await closeDatabase();
});

test('journal entries cannot be created in a closed fiscal period', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const periods = await fiscalPeriodService.listPeriods(fixture.tenant._id, { year: 2026 });
  const january = periods.find((period) => period.month === 1);

  await fiscalPeriodService.closePeriod(january._id, fixture.tenant._id, fixture.user._id, {
    auditContext: fixture.auditContext,
  });

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '4100']);

  await assert.rejects(() => journalService.createEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2026, 0, 15)).toISOString(),
      description: 'Closed period check',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '100.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '100.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  ), /closed/i);
});

test('posted journal entries remain immutable after posting', async () => {
  const fixture = await createTenantFixture({ fiscalYear: new Date().getFullYear() });
  tenantIds.add(fixture.tenant._id);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '4100']);
  const postedEntry = await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date().toISOString(),
      description: 'Posted entry immutability',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '250.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '250.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  await assert.rejects(() => journalService.updateEntry(
    postedEntry._id,
    fixture.tenant._id,
    fixture.user._id,
    { description: 'Should fail' },
    { auditContext: fixture.auditContext }
  ), /immutable/i);
});

test('soft-deleted draft entries are excluded from journal list totals and dashboard stats', async () => {
  const fixture = await createTenantFixture({ fiscalYear: new Date().getFullYear() });
  tenantIds.add(fixture.tenant._id);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '4100']);

  const deletedDraft = await journalService.createEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date().toISOString(),
      description: 'Draft to delete',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '125.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '125.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  await journalService.deleteEntry(
    deletedDraft._id,
    fixture.tenant._id,
    fixture.user._id,
    { auditContext: fixture.auditContext }
  );

  await journalService.createEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date().toISOString(),
      description: 'Active draft entry',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '75.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '75.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date().toISOString(),
      description: 'Active posted entry',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '50.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '50.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  const { entries, total } = await journalService.listEntries(
    fixture.tenant._id,
    { page: 1, limit: 20, skip: 0 }
  );
  const stats = await dashboardService.getStats(fixture.tenant._id);

  assert.equal(total, 2);
  assert.equal(entries.length, 2);
  assert.equal(stats.totalEntries, 2);
  assert.equal(stats.draftEntries, 1);
  assert.equal(stats.postedEntries, 1);
  assert.equal(stats.recentEntries.length, 2);
  assert.ok(
    stats.recentEntries.every((entry) => entry.description !== 'Draft to delete')
  );
});
