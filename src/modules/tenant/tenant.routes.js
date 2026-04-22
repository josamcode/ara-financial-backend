'use strict';

const { Router } = require('express');
const multer = require('multer');
const tenantController = require('./tenant.controller');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { BadRequestError } = require('../../common/errors');
const { PERMISSIONS } = require('../auth/role.model');

const router = Router();
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      cb(new BadRequestError('Only image files are allowed'));
      return;
    }

    cb(null, true);
  },
});

function uploadTenantLogo(req, res, next) {
  logoUpload.single('logo')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      next(new BadRequestError('Logo image must be 5MB or smaller'));
      return;
    }

    if (error instanceof BadRequestError) {
      next(error);
      return;
    }

    next(new BadRequestError(error.message || 'Unable to upload logo'));
  });
}

router.use(authenticate, tenantContext);

router.get(
  '/',
  authorize(PERMISSIONS.TENANT_READ),
  asyncHandler(tenantController.get)
);

router.patch(
  '/settings',
  authorize(PERMISSIONS.TENANT_UPDATE),
  asyncHandler(tenantController.updateSettings)
);

router.post(
  '/logo',
  authorize(PERMISSIONS.TENANT_UPDATE),
  uploadTenantLogo,
  asyncHandler(tenantController.uploadLogo)
);

router.post(
  '/complete-setup',
  authorize(PERMISSIONS.TENANT_UPDATE),
  asyncHandler(tenantController.completeSetup)
);

module.exports = router;
