'use strict';

const { Router } = require('express');
const controller = require('./bill.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const { createBillSchema } = require('./bill.validation');

const router = Router();

router.use(authenticate, tenantContext);

router.post(
  '/',
  authorize(PERMISSIONS.BILL_CREATE),
  validate({ body: createBillSchema }),
  asyncHandler(controller.create)
);

router.get(
  '/',
  authorize(PERMISSIONS.BILL_READ),
  asyncHandler(controller.list)
);

router.get(
  '/:id',
  authorize(PERMISSIONS.BILL_READ),
  asyncHandler(controller.getById)
);

module.exports = router;
