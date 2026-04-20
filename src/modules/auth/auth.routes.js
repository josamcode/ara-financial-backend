'use strict';

const { Router } = require('express');
const authController = require('./auth.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate } = require('../../common/middleware/auth');
const {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  acceptInviteSchema,
  resetPasswordSchema,
} = require('./auth.validation');

const router = Router();

// Public routes
router.post(
  '/register',
  validate({ body: registerSchema }),
  asyncHandler(authController.register)
);

router.post(
  '/login',
  validate({ body: loginSchema }),
  asyncHandler(authController.login)
);

router.post(
  '/accept-invite',
  validate({ body: acceptInviteSchema }),
  asyncHandler(authController.acceptInvite)
);

router.post(
  '/forgot-password',
  validate({ body: forgotPasswordSchema }),
  asyncHandler(authController.forgotPassword)
);

router.post(
  '/reset-password',
  validate({ body: resetPasswordSchema }),
  asyncHandler(authController.resetPassword)
);

router.post(
  '/refresh',
  validate({ body: refreshSchema }),
  asyncHandler(authController.refresh)
);

// Protected routes
router.post(
  '/logout',
  authenticate,
  validate({ body: logoutSchema }),
  asyncHandler(authController.logout)
);

router.get(
  '/me',
  authenticate,
  asyncHandler(authController.me)
);

module.exports = router;
