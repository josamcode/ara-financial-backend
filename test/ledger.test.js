'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ledgerService = require('../src/modules/ledger/ledger.service');
const {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
  createPostedEntry,
  getAccountsByCode,
} = require('./helpers/integration');

const tenantIds = new Set();

test.before(async () => {
  await ensureDatabase();
});

test.after(async () => {
  await cleanupTenantData(tenantIds);
  await closeDatabase();
});

test('ledger running balances follow each account normal balance direction', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '4100']);

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2026, 0, 15, 12, 0, 0)).toISOString(),
      description: 'Ledger balance direction test',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '100.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '100.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  const cashLedger = await ledgerService.getAccountLedger(
    fixture.tenant._id,
    accounts.get('1111')._id.toString(),
    { page: 1, limit: 20, skip: 0 }
  );
  const revenueLedger = await ledgerService.getAccountLedger(
    fixture.tenant._id,
    accounts.get('4100')._id.toString(),
    { page: 1, limit: 20, skip: 0 }
  );

  assert.equal(cashLedger.movements[0]?.balance, '100');
  assert.equal(revenueLedger.movements[0]?.balance, '100');
});
