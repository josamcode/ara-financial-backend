'use strict';

const { Router } = require('express');
const controller = require('./customer.controller');
const validate = require('../../common/middleware/validate');
const asyncHandler = require('../../common/middleware/asyncHandler');
const { authenticate, authorize, tenantContext } = require('../../common/middleware/auth');
const { PERMISSIONS } = require('../auth/role.model');
const { createCustomerSchema, updateCustomerSchema } = require('./customer.validation');

const router = Router();

router.use(authenticate, tenantContext);

router.get('/', authorize(PERMISSIONS.CUSTOMER_READ), asyncHandler(controller.list));
router.post('/', authorize(PERMISSIONS.CUSTOMER_CREATE), validate({ body: createCustomerSchema }), asyncHandler(controller.create));
router.get('/:id', authorize(PERMISSIONS.CUSTOMER_READ), asyncHandler(controller.getById));
router.get('/:id/invoices', authorize(PERMISSIONS.CUSTOMER_READ), asyncHandler(controller.getInvoices));
router.patch('/:id', authorize(PERMISSIONS.CUSTOMER_UPDATE), validate({ body: updateCustomerSchema }), asyncHandler(controller.update));
router.delete('/:id', authorize(PERMISSIONS.CUSTOMER_DELETE), asyncHandler(controller.delete));

module.exports = router;
