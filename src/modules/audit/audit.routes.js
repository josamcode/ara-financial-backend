'use strict';

const { Router } = require('express');
const auditController = require('./audit.controller');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');

const router = Router();

router.use(authenticate, tenantContext);

router.get(
  '/',
  authorize(PERMISSIONS.AUDIT_READ),
  asyncHandler(auditController.list)
);

module.exports = router;
