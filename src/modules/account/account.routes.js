'use strict';

const { Router } = require('express');
const accountController = require('./account.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const { createAccountSchema, updateAccountSchema } = require('./account.validation');

const router = Router();

router.use(authenticate, tenantContext);

router.get(
  '/',
  authorize(PERMISSIONS.ACCOUNT_READ),
  asyncHandler(accountController.list)
);

router.get(
  '/tree',
  authorize(PERMISSIONS.ACCOUNT_READ),
  asyncHandler(accountController.tree)
);

router.get(
  '/:id',
  authorize(PERMISSIONS.ACCOUNT_READ),
  asyncHandler(accountController.getById)
);

router.post(
  '/',
  authorize(PERMISSIONS.ACCOUNT_CREATE),
  validate({ body: createAccountSchema }),
  asyncHandler(accountController.create)
);

router.post(
  '/template',
  authorize(PERMISSIONS.ACCOUNT_CREATE),
  asyncHandler(accountController.applyTemplate)
);

router.patch(
  '/:id',
  authorize(PERMISSIONS.ACCOUNT_UPDATE),
  validate({ body: updateAccountSchema }),
  asyncHandler(accountController.update)
);

router.delete(
  '/:id',
  authorize(PERMISSIONS.ACCOUNT_DELETE),
  asyncHandler(accountController.delete)
);

module.exports = router;
