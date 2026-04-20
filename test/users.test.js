'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AuditLog = require('../src/modules/audit/audit.model');
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

test('GET /users/profile returns the current user without creating profile update audit logs', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const beforeCount = await AuditLog.countDocuments({
    tenantId: fixture.tenant._id,
    userId: fixture.user._id,
    action: 'user.profile_updated',
  });

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/users/profile`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  const afterCount = await AuditLog.countDocuments({
    tenantId: fixture.tenant._id,
    userId: fixture.user._id,
    action: 'user.profile_updated',
  });

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.user._id, String(fixture.user._id));
  assert.equal(body.data.user.email, fixture.user.email);
  assert.equal(afterCount, beforeCount);
});

test('PATCH /users/profile still updates the profile and records the update audit entry', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const beforeCount = await AuditLog.countDocuments({
    tenantId: fixture.tenant._id,
    userId: fixture.user._id,
    action: 'user.profile_updated',
  });

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/users/profile`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Updated Profile Name',
      }),
    }
  );

  const afterCount = await AuditLog.countDocuments({
    tenantId: fixture.tenant._id,
    userId: fixture.user._id,
    action: 'user.profile_updated',
  });

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.user.name, 'Updated Profile Name');
  assert.equal(afterCount, beforeCount + 1);
});
