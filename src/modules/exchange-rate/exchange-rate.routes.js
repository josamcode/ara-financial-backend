'use strict';

const { Router } = require('express');
const controller = require('./exchange-rate.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const {
  createExchangeRateSchema,
  updateExchangeRateSchema,
  latestExchangeRateQuerySchema,
  listExchangeRatesQuerySchema,
  exchangeRateIdParamSchema,
} = require('./exchange-rate.validation');

const router = Router();

router.use(authenticate, tenantContext);

router.get(
  '/',
  authorize(PERMISSIONS.EXCHANGE_RATE_READ),
  validate({ query: listExchangeRatesQuerySchema }),
  asyncHandler(controller.list)
);

router.post(
  '/',
  authorize(PERMISSIONS.EXCHANGE_RATE_MANAGE),
  validate({ body: createExchangeRateSchema }),
  asyncHandler(controller.create)
);

router.get(
  '/latest',
  authorize(PERMISSIONS.EXCHANGE_RATE_READ),
  validate({ query: latestExchangeRateQuerySchema }),
  asyncHandler(controller.latest)
);

router.patch(
  '/:id',
  authorize(PERMISSIONS.EXCHANGE_RATE_MANAGE),
  validate({ params: exchangeRateIdParamSchema, body: updateExchangeRateSchema }),
  asyncHandler(controller.update)
);

router.delete(
  '/:id',
  authorize(PERMISSIONS.EXCHANGE_RATE_MANAGE),
  validate({ params: exchangeRateIdParamSchema }),
  asyncHandler(controller.deactivate)
);

module.exports = router;
