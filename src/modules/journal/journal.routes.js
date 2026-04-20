'use strict';

const { Router } = require('express');
const controller = require('./journal.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const { createJournalEntrySchema, updateJournalEntrySchema } = require('./journal.validation');

const router = Router();

router.use(authenticate, tenantContext);

router.post(
  '/',
  authorize(PERMISSIONS.JOURNAL_CREATE),
  validate({ body: createJournalEntrySchema }),
  asyncHandler(controller.create)
);

router.get(
  '/',
  authorize(PERMISSIONS.JOURNAL_READ),
  asyncHandler(controller.list)
);

router.get(
  '/export',
  authorize(PERMISSIONS.REPORT_EXPORT),
  asyncHandler(controller.exportCSV)
);

router.get(
  '/:id',
  authorize(PERMISSIONS.JOURNAL_READ),
  asyncHandler(controller.getById)
);

router.patch(
  '/:id',
  authorize(PERMISSIONS.JOURNAL_UPDATE),
  validate({ body: updateJournalEntrySchema }),
  asyncHandler(controller.update)
);

router.post(
  '/:id/post',
  authorize(PERMISSIONS.JOURNAL_POST),
  asyncHandler(controller.post)
);

router.post(
  '/:id/reverse',
  authorize(PERMISSIONS.JOURNAL_CREATE),
  asyncHandler(controller.reverse)
);

router.delete(
  '/:id',
  authorize(PERMISSIONS.JOURNAL_DELETE),
  asyncHandler(controller.delete)
);

module.exports = router;
