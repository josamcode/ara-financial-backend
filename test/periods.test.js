'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fiscalPeriodService = require('../src/modules/fiscal-period/fiscalPeriod.service');
const {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
} = require('./helpers/integration');

const tenantIds = new Set();

test.before(async () => {
  await ensureDatabase();
});

test.after(async () => {
  await cleanupTenantData(tenantIds);
  await closeDatabase();
});

test('fiscal periods can be closed and reopened while preserving lock rules', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const periods = await fiscalPeriodService.listPeriods(fixture.tenant._id, { year: 2026 });
  const january = periods.find((period) => period.month === 1);
  const february = periods.find((period) => period.month === 2);

  const closed = await fiscalPeriodService.closePeriod(
    january._id,
    fixture.tenant._id,
    fixture.user._id,
    { auditContext: fixture.auditContext }
  );
  assert.equal(closed.status, 'closed');

  const reopened = await fiscalPeriodService.reopenPeriod(
    january._id,
    fixture.tenant._id,
    { userId: fixture.user._id, auditContext: fixture.auditContext }
  );
  assert.equal(reopened.status, 'open');

  const locked = await fiscalPeriodService.lockPeriod(
    february._id,
    fixture.tenant._id,
    fixture.user._id,
    { auditContext: fixture.auditContext }
  );
  assert.equal(locked.status, 'locked');

  await assert.rejects(() => fiscalPeriodService.reopenPeriod(
    february._id,
    fixture.tenant._id,
    { userId: fixture.user._id, auditContext: fixture.auditContext }
  ), /locked/i);
});

test('findPeriodForDate locates the matching fiscal period by calendar date', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const period = await fiscalPeriodService.findPeriodForDate(
    fixture.tenant._id,
    new Date(Date.UTC(2026, 6, 10))
  );

  assert.equal(period?.month, 7);
  assert.equal(period?.year, 2026);
});

test('fiscal year creation uses UTC-safe inclusive month boundaries', async () => {
  const fixture = await createTenantFixture({
    createFiscalYear: false,
    applyTemplate: false,
  });
  tenantIds.add(fixture.tenant._id);

  await fiscalPeriodService.createFiscalYear(
    fixture.tenant._id,
    { year: 2026 },
    { userId: fixture.user._id, auditContext: fixture.auditContext }
  );

  const january = await fiscalPeriodService.findPeriodForDate(
    fixture.tenant._id,
    new Date('2026-01-31T12:00:00.000Z'),
    { required: true }
  );

  assert.equal(january.month, 1);
  assert.equal(january.startDate.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(january.endDate.toISOString(), '2026-01-31T23:59:59.999Z');
});

test('fiscal year creation rejects overlapping and gapped timelines', async () => {
  const fixture = await createTenantFixture({
    createFiscalYear: false,
    applyTemplate: false,
  });
  tenantIds.add(fixture.tenant._id);

  await fiscalPeriodService.createFiscalYear(
    fixture.tenant._id,
    { year: 2026, startMonth: 4 },
    { userId: fixture.user._id, auditContext: fixture.auditContext }
  );

  await assert.rejects(() => fiscalPeriodService.createFiscalYear(
    fixture.tenant._id,
    { year: 2027, startMonth: 1 },
    { userId: fixture.user._id, auditContext: fixture.auditContext }
  ), /overlap/i);

  await fiscalPeriodService.createFiscalYear(
    fixture.tenant._id,
    { year: 2027, startMonth: 4 },
    { userId: fixture.user._id, auditContext: fixture.auditContext }
  );

  await assert.rejects(() => fiscalPeriodService.createFiscalYear(
    fixture.tenant._id,
    { year: 2029, startMonth: 4 },
    { userId: fixture.user._id, auditContext: fixture.auditContext }
  ), /continuous|gap/i);
});
