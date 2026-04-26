'use strict';

const { Router } = require('express');
const controller = require('./tax.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const {
  createTaxRateSchema,
  updateTaxRateSchema,
  listTaxRatesQuerySchema,
  idParamSchema,
} = require('./tax.validation');

const router = Router();

router.use(authenticate, tenantContext);

router.get(
  '/',
  authorize(PERMISSIONS.TAX_READ),
  validate({ query: listTaxRatesQuerySchema }),
  asyncHandler(controller.list)
);

router.get(
  '/:id',
  authorize(PERMISSIONS.TAX_READ),
  validate({ params: idParamSchema }),
  asyncHandler(controller.getById)
);

router.post(
  '/',
  authorize(PERMISSIONS.TAX_MANAGE),
  validate({ body: createTaxRateSchema }),
  asyncHandler(controller.create)
);

router.patch(
  '/:id',
  authorize(PERMISSIONS.TAX_MANAGE),
  validate({ params: idParamSchema, body: updateTaxRateSchema }),
  asyncHandler(controller.update)
);

router.delete(
  '/:id',
  authorize(PERMISSIONS.TAX_MANAGE),
  validate({ params: idParamSchema }),
  asyncHandler(controller.delete)
);

module.exports = router;
