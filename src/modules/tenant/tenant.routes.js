'use strict';

const { Router } = require('express');
const tenantController = require('./tenant.controller');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');

const router = Router();

router.use(authenticate, tenantContext);

router.get(
  '/',
  authorize(PERMISSIONS.TENANT_READ),
  asyncHandler(tenantController.get)
);

router.patch(
  '/settings',
  authorize(PERMISSIONS.TENANT_UPDATE),
  asyncHandler(tenantController.updateSettings)
);

router.post(
  '/complete-setup',
  authorize(PERMISSIONS.TENANT_UPDATE),
  asyncHandler(tenantController.completeSetup)
);

module.exports = router;
