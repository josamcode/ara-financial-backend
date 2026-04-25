'use strict';

const { Router } = require('express');
const controller = require('./payment.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const {
  createMyFatoorahPaymentSchema,
  myFatoorahCallbackQuerySchema,
} = require('./payment.validation');

const router = Router();

router.get(
  '/myfatoorah/callback',
  validate({ query: myFatoorahCallbackQuerySchema }),
  asyncHandler(controller.handleMyFatoorahCallback)
);

router.get(
  '/myfatoorah/error',
  validate({ query: myFatoorahCallbackQuerySchema }),
  asyncHandler(controller.handleMyFatoorahError)
);

router.use(authenticate, tenantContext);

router.post(
  '/myfatoorah/create',
  authorize(PERMISSIONS.PAYMENT_CREATE),
  validate({ body: createMyFatoorahPaymentSchema }),
  asyncHandler(controller.createMyFatoorahPayment)
);

module.exports = router;
