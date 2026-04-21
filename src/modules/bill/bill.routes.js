'use strict';

const { Router } = require('express');
const controller = require('./bill.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const {
  createBillSchema,
  postBillSchema,
  recordBillPaymentSchema,
} = require('./bill.validation');

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

router.post(
  '/:id/post',
  authorize(PERMISSIONS.BILL_CREATE),
  validate({ body: postBillSchema }),
  asyncHandler(controller.post)
);

router.post(
  '/:id/pay',
  authorize(PERMISSIONS.BILL_CREATE),
  validate({ body: recordBillPaymentSchema }),
  asyncHandler(controller.recordPayment)
);

router.post(
  '/:id/cancel',
  authorize(PERMISSIONS.BILL_CREATE),
  asyncHandler(controller.cancel)
);

module.exports = router;
