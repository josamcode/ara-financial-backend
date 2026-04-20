'use strict';

const { Router } = require('express');
const controller = require('./ledger.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const {
  accountIdParamSchema,
  ledgerQuerySchema,
  exportLedgerQuerySchema,
} = require('./ledger.validation');

const router = Router();

router.use(authenticate, tenantContext);

router.get(
  '/',
  authorize(PERMISSIONS.REPORT_VIEW),
  validate({ query: ledgerQuerySchema }),
  asyncHandler(controller.getAllLedger)
);

router.get(
  '/:accountId',
  authorize(PERMISSIONS.REPORT_VIEW),
  validate({ params: accountIdParamSchema, query: ledgerQuerySchema }),
  asyncHandler(controller.getAccountLedger)
);

router.get(
  '/:accountId/export',
  authorize(PERMISSIONS.REPORT_EXPORT),
  validate({ params: accountIdParamSchema, query: exportLedgerQuerySchema }),
  asyncHandler(controller.exportAccountLedger)
);

module.exports = router;
