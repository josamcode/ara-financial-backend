'use strict';

const { Router } = require('express');
const controller = require('./billing.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { ForbiddenError, UnauthorizedError } = require('../../common/errors');
const { PERMISSIONS } = require('../auth/role.model');
const {
  checkoutSchema,
  syncPaymentParamsSchema,
} = require('./billing.validation');

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

router.use(authenticate, tenantContext);

router.get(
  '/plans',
  authorizeAny(PERMISSIONS.BILLING_READ, PERMISSIONS.BILLING_MANAGE),
  asyncHandler(controller.listPlans)
);

router.get(
  '/subscription',
  authorizeAny(PERMISSIONS.BILLING_READ, PERMISSIONS.BILLING_MANAGE),
  asyncHandler(controller.getSubscription)
);

router.get(
  '/usage',
  authorizeAny(PERMISSIONS.BILLING_READ, PERMISSIONS.BILLING_MANAGE),
  asyncHandler(controller.getUsage)
);

router.post(
  '/checkout',
  authorize(PERMISSIONS.BILLING_MANAGE),
  validate({ body: checkoutSchema }),
  asyncHandler(controller.checkout)
);

router.post(
  '/sync-payment/:paymentAttemptId',
  authorize(PERMISSIONS.BILLING_MANAGE),
  validate({ params: syncPaymentParamsSchema }),
  asyncHandler(controller.syncPayment)
);

module.exports = router;
