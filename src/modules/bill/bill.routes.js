'use strict';

const { Router } = require('express');
const controller = require('./bill.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const {
  createBillSchema,
  updateBillSchema,
  postBillSchema,
  recordBillPaymentSchema,
  bulkBillIdsSchema,
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
  '/export',
  authorize(PERMISSIONS.BILL_READ),
  asyncHandler(controller.exportList)
);

router.post(
  '/bulk/cancel',
  authorize(PERMISSIONS.BILL_CREATE),
  validate({ body: bulkBillIdsSchema }),
  asyncHandler(controller.bulkCancel)
);

router.get(
  '/:id',
  authorize(PERMISSIONS.BILL_READ),
  asyncHandler(controller.getById)
);

router.patch(
  '/:id',
  authorize(PERMISSIONS.BILL_CREATE),
  validate({ body: updateBillSchema }),
  asyncHandler(controller.update)
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
