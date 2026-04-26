'use strict';

const { Router } = require('express');
const controller = require('./currency.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const {
  createCurrencySchema,
  updateCurrencySchema,
  listCurrenciesQuerySchema,
  currencyCodeParamSchema,
} = require('./currency.validation');

const router = Router();

router.use(authenticate, tenantContext);

router.get(
  '/',
  authorize(PERMISSIONS.CURRENCY_READ),
  validate({ query: listCurrenciesQuerySchema }),
  asyncHandler(controller.list)
);

router.get(
  '/:code',
  authorize(PERMISSIONS.CURRENCY_READ),
  validate({ params: currencyCodeParamSchema }),
  asyncHandler(controller.getByCode)
);

router.post(
  '/',
  authorize(PERMISSIONS.CURRENCY_MANAGE),
  validate({ body: createCurrencySchema }),
  asyncHandler(controller.create)
);

router.patch(
  '/:code',
  authorize(PERMISSIONS.CURRENCY_MANAGE),
  validate({ params: currencyCodeParamSchema, body: updateCurrencySchema }),
  asyncHandler(controller.update)
);

module.exports = router;
