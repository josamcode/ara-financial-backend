'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
  createServer,
  closeServer,
  fetchJson,
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

test('fiscal period routes validate both body and params inputs', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const invalidCreate = await fetchJson(
    `${serverContext.baseUrl}/api/v1/fiscal-periods`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        year: 2027,
        startMonth: 13,
      }),
    }
  );

  const invalidId = await fetchJson(
    `${serverContext.baseUrl}/api/v1/fiscal-periods/not-an-id`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  assert.equal(invalidCreate.response.status, 422);
  assert.equal(invalidCreate.body.error.code, 'VALIDATION_ERROR');
  assert.equal(invalidId.response.status, 422);
  assert.equal(invalidId.body.error.code, 'VALIDATION_ERROR');
});

test('ledger routes validate query and accountId params before controller execution', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const invalidQuery = await fetchJson(
    `${serverContext.baseUrl}/api/v1/ledger?startDate=not-a-date`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  const invalidAccountId = await fetchJson(
    `${serverContext.baseUrl}/api/v1/ledger/not-an-id`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  assert.equal(invalidQuery.response.status, 422);
  assert.equal(invalidQuery.body.error.code, 'VALIDATION_ERROR');
  assert.equal(invalidAccountId.response.status, 422);
  assert.equal(invalidAccountId.body.error.code, 'VALIDATION_ERROR');
});

test('report routes reject unexpected query inputs with a 422 validation response', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/reports/trial-balance?unexpected=true`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  assert.equal(response.status, 422);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});
