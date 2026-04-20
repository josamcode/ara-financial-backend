'use strict';

const { Router } = require('express');
const userController = require('./user.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const { inviteUserSchema, updateRoleSchema, updateProfileSchema } = require('./user.validation');

const router = Router();

// All routes require authentication and tenant context
router.use(authenticate, tenantContext);

router.get(
  '/',
  authorize(PERMISSIONS.USER_READ),
  asyncHandler(userController.list)
);

router.get(
  '/profile',
  asyncHandler(userController.getProfile)
);

router.patch(
  '/profile',
  validate({ body: updateProfileSchema }),
  asyncHandler(userController.updateProfile)
);

router.get(
  '/:id',
  authorize(PERMISSIONS.USER_READ),
  asyncHandler(userController.getById)
);

router.post(
  '/invite',
  authorize(PERMISSIONS.USER_INVITE),
  validate({ body: inviteUserSchema }),
  asyncHandler(userController.invite)
);

router.patch(
  '/:id/role',
  authorize(PERMISSIONS.USER_UPDATE),
  validate({ body: updateRoleSchema }),
  asyncHandler(userController.changeRole)
);

router.patch(
  '/:id/deactivate',
  authorize(PERMISSIONS.USER_DEACTIVATE),
  asyncHandler(userController.deactivate)
);

module.exports = router;
