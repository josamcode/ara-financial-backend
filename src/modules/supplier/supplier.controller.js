'use strict';

const supplierService = require('./supplier.service');
const { getAuditContext } = require('../../common/utils/audit');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const controller = {
  async list(req, res) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim() || undefined;

    const { suppliers, total } = await supplierService.listSuppliers(req.tenantId, {
      limit,
      skip,
      search,
    });

    res.json({
      success: true,
      data: {
        suppliers,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  },

  async getById(req, res) {
    const supplier = await supplierService.getSupplierById(req.params.id, req.tenantId);
    res.json({ success: true, data: { supplier } });
  },

  async getStatement(req, res) {
    const result = await supplierService.getSupplierStatement(req.params.id, req.tenantId);
    res.json({ success: true, data: result });
  },

  async create(req, res) {
    const supplier = await supplierService.createSupplier(
      req.tenantId,
      req.user.userId,
      req.body,
      { auditContext: getAuditContext(req) }
    );
    res.status(201).json({ success: true, data: { supplier } });
  },

  async update(req, res) {
    const supplier = await supplierService.updateSupplier(
      req.params.id,
      req.tenantId,
      req.user.userId,
      req.body,
      { auditContext: getAuditContext(req) }
    );
    res.json({ success: true, data: { supplier } });
  },

  async delete(req, res) {
    await supplierService.deleteSupplier(
      req.params.id,
      req.tenantId,
      req.user.userId,
      { auditContext: getAuditContext(req) }
    );
    res.json({ success: true, data: null });
  },
};

module.exports = controller;
