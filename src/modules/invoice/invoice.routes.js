'use strict';

const { Router } = require('express');
const controller = require('./invoice.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const {
  createInvoiceSchema,
  updateInvoiceSchema,
  markSentSchema,
  recordPaymentSchema,
} = require('./invoice.validation');

const router = Router();

router.use(authenticate, tenantContext);

router.post(
  '/',
  authorize(PERMISSIONS.INVOICE_CREATE),
  validate({ body: createInvoiceSchema }),
  asyncHandler(controller.create)
);

router.get(
  '/',
  authorize(PERMISSIONS.INVOICE_READ),
  asyncHandler(controller.list)
);

router.get(
  '/:id',
  authorize(PERMISSIONS.INVOICE_READ),
  asyncHandler(controller.getById)
);

router.patch(
  '/:id',
  authorize(PERMISSIONS.INVOICE_UPDATE),
  validate({ body: updateInvoiceSchema }),
  asyncHandler(controller.update)
);

router.post(
  '/:id/send',
  authorize(PERMISSIONS.INVOICE_SEND),
  validate({ body: markSentSchema }),
  asyncHandler(controller.markAsSent)
);

router.post(
  '/:id/pay',
  authorize(PERMISSIONS.INVOICE_SEND),
  validate({ body: recordPaymentSchema }),
  asyncHandler(controller.recordPayment)
);

router.post(
  '/:id/cancel',
  authorize(PERMISSIONS.INVOICE_UPDATE),
  asyncHandler(controller.cancel)
);

router.delete(
  '/:id',
  authorize(PERMISSIONS.INVOICE_DELETE),
  asyncHandler(controller.delete)
);

module.exports = router;
