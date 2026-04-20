'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authenticate, authorize, tenantContext } = require('../src/common/middleware/auth');
const {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
} = require('./helpers/integration');

const tenantIds = new Set();

function runMiddleware(middleware, req) {
  return new Promise((resolve) => {
    middleware(req, {}, (error) => resolve(error || null));
  });
}

test.before(async () => {
  await ensureDatabase();
});

test.after(async () => {
  await cleanupTenantData(tenantIds);
  await closeDatabase();
});

test('authorize rejects requests missing the required permission', async () => {
  const req = {
    user: {
      permissions: ['report:view'],
    },
  };

  const error = await runMiddleware(authorize('report:export'), req);
  assert.equal(error?.statusCode, 403);
});

test('tenantContext requires a tenant-aware authenticated user', async () => {
  const req = {
    user: {
      userId: 'user-1',
      permissions: [],
    },
  };

  const error = await runMiddleware(tenantContext, req);
  assert.equal(error?.statusCode, 401);
});

test('authenticate attaches the current persisted user context from a valid access token', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const req = {
    headers: {
      authorization: `Bearer ${fixture.accessToken}`,
    },
  };

  const error = await runMiddleware(authenticate, req);

  assert.equal(error, null);
  assert.deepEqual(req.user, {
    userId: fixture.user._id.toString(),
    tenantId: fixture.tenant._id.toString(),
    roleId: fixture.user.roleId.toString(),
    roleName: 'owner',
    permissions: req.user.permissions,
  });
  assert.ok(req.user.permissions.includes('report:view'));
});
