'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const authService = require('../src/modules/auth/auth.service');
const userService = require('../src/modules/user/user.service');
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

test('forgot-password returns a generic response by default and does not expose reset tokens', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/auth/forgot-password`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: fixture.user.email,
      }),
    }
  );

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(
    body.data.message,
    'If an account exists for that email, password reset instructions have been issued.'
  );
  assert.equal(body.data.passwordReset, undefined);
});

test('logout keeps working without a refresh token and rejects malformed token payloads', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const successResponse = await fetchJson(
    `${serverContext.baseUrl}/api/v1/auth/logout`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  );

  assert.equal(successResponse.response.status, 200);
  assert.equal(successResponse.body.success, true);

  const invalidResponse = await fetchJson(
    `${serverContext.baseUrl}/api/v1/auth/logout`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        refreshToken: 123,
      }),
    }
  );

  assert.equal(invalidResponse.response.status, 422);
  assert.equal(invalidResponse.body.error.code, 'VALIDATION_ERROR');
});

test('deactivated users immediately lose API access even with an existing access token', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const invited = await userService.inviteUser(
    fixture.tenant._id,
    fixture.user._id,
    {
      email: `deactivated_${Date.now()}@example.com`,
      name: 'Deactivated User',
      roleName: 'admin',
    },
    { auditContext: fixture.auditContext }
  );

  const accepted = await authService.acceptInvite(
    {
      token: invited.invitation.token,
      password: 'TestPass1',
      name: 'Deactivated User',
    },
    { auditContext: fixture.auditContext }
  );

  await userService.deactivateUser(
    accepted.user._id,
    fixture.tenant._id,
    fixture.user._id,
    { auditContext: fixture.auditContext }
  );

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/users/profile`,
    {
      headers: {
        Authorization: `Bearer ${accepted.accessToken}`,
      },
    }
  );

  assert.equal(response.status, 401);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('role changes take effect immediately for existing access tokens', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const invited = await userService.inviteUser(
    fixture.tenant._id,
    fixture.user._id,
    {
      email: `role_change_${Date.now()}@example.com`,
      name: 'Role Change User',
      roleName: 'admin',
    },
    { auditContext: fixture.auditContext }
  );

  const accepted = await authService.acceptInvite(
    {
      token: invited.invitation.token,
      password: 'TestPass1',
      name: 'Role Change User',
    },
    { auditContext: fixture.auditContext }
  );

  await userService.changeUserRole(
    accepted.user._id,
    fixture.tenant._id,
    fixture.user._id,
    { roleName: 'accountant' },
    { auditContext: fixture.auditContext }
  );

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/users/invite`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accepted.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: `blocked_${Date.now()}@example.com`,
        name: 'Blocked Invite',
        roleName: 'accountant',
      }),
    }
  );

  assert.equal(response.status, 403);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'FORBIDDEN');
});
