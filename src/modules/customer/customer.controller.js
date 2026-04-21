'use strict';

const customerService = require('./customer.service');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const controller = {
  async list(req, res) {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim() || undefined;

    const { customers, total } = await customerService.listCustomers(req.tenantId, {
      page,
      limit,
      skip,
      search,
    });

    res.json({
      success: true,
      data: {
        customers,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  },

  async getById(req, res) {
    const customer = await customerService.getCustomerById(req.params.id, req.tenantId);
    res.json({ success: true, data: { customer } });
  },

  async getInvoices(req, res) {
    const result = await customerService.getCustomerInvoices(req.params.id, req.tenantId);
    res.json({ success: true, data: result });
  },

  async getStatement(req, res) {
    const result = await customerService.getCustomerStatement(req.params.id, req.tenantId);
    res.json({ success: true, data: result });
  },

  async create(req, res) {
    const customer = await customerService.createCustomer(
      req.tenantId,
      req.user._id,
      req.body,
      { auditContext: req.auditContext }
    );
    res.status(201).json({ success: true, data: { customer } });
  },

  async update(req, res) {
    const customer = await customerService.updateCustomer(
      req.params.id,
      req.tenantId,
      req.user._id,
      req.body,
      { auditContext: req.auditContext }
    );
    res.json({ success: true, data: { customer } });
  },

  async delete(req, res) {
    await customerService.deleteCustomer(
      req.params.id,
      req.tenantId,
      req.user._id,
      { auditContext: req.auditContext }
    );
    res.json({ success: true, data: null });
  },
};

module.exports = controller;
