'use strict';

const { Router } = require('express');
const controller = require('./fiscalPeriod.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const {
  periodIdParamSchema,
  listPeriodsQuerySchema,
  createFiscalYearSchema,
} = require('./fiscalPeriod.validation');

const router = Router();

router.use(authenticate, tenantContext);

router.get(
  '/',
  authorize(PERMISSIONS.FISCAL_READ),
  validate({ query: listPeriodsQuerySchema }),
  asyncHandler(controller.list)
);
router.get(
  '/:id',
  authorize(PERMISSIONS.FISCAL_READ),
  validate({ params: periodIdParamSchema }),
  asyncHandler(controller.getById)
);
router.post(
  '/',
  authorize(PERMISSIONS.FISCAL_CREATE),
  validate({ body: createFiscalYearSchema }),
  asyncHandler(controller.createYear)
);
router.post(
  '/:id/close',
  authorize(PERMISSIONS.FISCAL_UPDATE),
  validate({ params: periodIdParamSchema }),
  asyncHandler(controller.close)
);
router.post(
  '/:id/lock',
  authorize(PERMISSIONS.FISCAL_LOCK),
  validate({ params: periodIdParamSchema }),
  asyncHandler(controller.lock)
);
router.post(
  '/:id/reopen',
  authorize(PERMISSIONS.FISCAL_UPDATE),
  validate({ params: periodIdParamSchema }),
  asyncHandler(controller.reopen)
);

module.exports = router;
