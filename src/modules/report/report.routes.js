'use strict';

const { Router } = require('express');
const controller = require('./report.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const {
  trialBalanceQuerySchema,
  incomeStatementQuerySchema,
  balanceSheetQuerySchema,
  cashFlowQuerySchema,
  arAgingQuerySchema,
  apAgingQuerySchema,
  vatReturnQuerySchema,
  trialBalanceExportQuerySchema,
  incomeStatementExportQuerySchema,
  balanceSheetExportQuerySchema,
  cashFlowExportQuerySchema,
} = require('./report.validation');

const router = Router();

router.use(authenticate, tenantContext);

// Reports (JSON)
router.get(
  '/trial-balance',
  authorize(PERMISSIONS.REPORT_VIEW),
  validate({ query: trialBalanceQuerySchema }),
  asyncHandler(controller.trialBalance)
);
router.get(
  '/income-statement',
  authorize(PERMISSIONS.REPORT_VIEW),
  validate({ query: incomeStatementQuerySchema }),
  asyncHandler(controller.incomeStatement)
);
router.get(
  '/balance-sheet',
  authorize(PERMISSIONS.REPORT_VIEW),
  validate({ query: balanceSheetQuerySchema }),
  asyncHandler(controller.balanceSheet)
);
router.get(
  '/cash-flow',
  authorize(PERMISSIONS.REPORT_VIEW),
  validate({ query: cashFlowQuerySchema }),
  asyncHandler(controller.cashFlow)
);
router.get(
  '/ar-aging',
  authorize(PERMISSIONS.REPORT_VIEW),
  validate({ query: arAgingQuerySchema }),
  asyncHandler(controller.arAging)
);
router.get(
  '/ap-aging',
  authorize(PERMISSIONS.REPORT_VIEW),
  validate({ query: apAgingQuerySchema }),
  asyncHandler(controller.apAging)
);
router.get(
  '/vat-return',
  authorize(PERMISSIONS.REPORT_VIEW),
  validate({ query: vatReturnQuerySchema }),
  asyncHandler(controller.vatReturn)
);

// Exports
router.get(
  '/trial-balance/export',
  authorize(PERMISSIONS.REPORT_EXPORT),
  validate({ query: trialBalanceExportQuerySchema }),
  asyncHandler(controller.exportTrialBalance)
);
router.get(
  '/income-statement/export',
  authorize(PERMISSIONS.REPORT_EXPORT),
  validate({ query: incomeStatementExportQuerySchema }),
  asyncHandler(controller.exportIncomeStatement)
);
router.get(
  '/balance-sheet/export',
  authorize(PERMISSIONS.REPORT_EXPORT),
  validate({ query: balanceSheetExportQuerySchema }),
  asyncHandler(controller.exportBalanceSheet)
);
router.get(
  '/cash-flow/export',
  authorize(PERMISSIONS.REPORT_EXPORT),
  validate({ query: cashFlowExportQuerySchema }),
  asyncHandler(controller.exportCashFlow)
);

module.exports = router;
