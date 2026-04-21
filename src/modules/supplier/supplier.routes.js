'use strict';

const { Router } = require('express');
const controller = require('./supplier.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const { createSupplierSchema, updateSupplierSchema } = require('./supplier.validation');

const router = Router();

router.use(authenticate, tenantContext);

router.get('/', authorize(PERMISSIONS.SUPPLIER_READ), asyncHandler(controller.list));
router.post(
  '/',
  authorize(PERMISSIONS.SUPPLIER_CREATE),
  validate({ body: createSupplierSchema }),
  asyncHandler(controller.create)
);
router.get('/:id', authorize(PERMISSIONS.SUPPLIER_READ), asyncHandler(controller.getById));
router.get('/:id/statement', authorize(PERMISSIONS.SUPPLIER_READ), asyncHandler(controller.getStatement));
router.patch(
  '/:id',
  authorize(PERMISSIONS.SUPPLIER_UPDATE),
  validate({ body: updateSupplierSchema }),
  asyncHandler(controller.update)
);
router.delete('/:id', authorize(PERMISSIONS.SUPPLIER_DELETE), asyncHandler(controller.delete));

module.exports = router;
