'use strict';

const { Router } = require('express');
const controller = require('./payment.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { ForbiddenError, UnauthorizedError } = require('../../common/errors');
const { PERMISSIONS } = require('../auth/role.model');
const {
  createMyFatoorahPaymentSchema,
  listPaymentAttemptsQuerySchema,
  paymentAttemptParamsSchema,
  myFatoorahCallbackQuerySchema,
} = require('./payment.validation');

const router = Router();

function authorizeAny(...requiredPermissions) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    const userPermissions = req.user.permissions || [];
    const hasPermission = requiredPermissions.some((permission) =>
      userPermissions.includes(permission)
    );

    if (!hasPermission) {
      return next(new ForbiddenError('You do not have permission to perform this action'));
    }

    return next();
  };
}

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

router.get(
  '/',
  authorize(PERMISSIONS.PAYMENT_READ),
  validate({ query: listPaymentAttemptsQuerySchema }),
  asyncHandler(controller.list)
);

router.post(
  '/myfatoorah/create',
  authorize(PERMISSIONS.PAYMENT_CREATE),
  validate({ body: createMyFatoorahPaymentSchema }),
  asyncHandler(controller.createMyFatoorahPayment)
);

router.get(
  '/:id',
  authorize(PERMISSIONS.PAYMENT_READ),
  validate({ params: paymentAttemptParamsSchema }),
  asyncHandler(controller.getById)
);

router.post(
  '/:id/verify',
  authorizeAny(PERMISSIONS.PAYMENT_READ, PERMISSIONS.PAYMENT_CREATE),
  validate({ params: paymentAttemptParamsSchema }),
  asyncHandler(controller.verify)
);

module.exports = router;
