'use strict';

const invoiceService = require('./invoice.service');
const { getAuditContext } = require('../../common/utils/audit');
const { success, created, paginated, parsePagination, buildPaginationMeta } = require('../../common/utils/response');

class InvoiceController {
  async create(req, res) {
    const auditContext = getAuditContext(req);
    const invoice = await invoiceService.createInvoice(
      req.user.tenantId, req.user.userId, req.body, { auditContext }
    );
    return created(res, { invoice });
  }

  async list(req, res) {
    const pagination = parsePagination(req.query);
    const {
      status,
      search,
      dateFrom,
      dateTo,
      startDate,
      endDate,
      minAmount,
      maxAmount,
    } = req.query;
    const { invoices, total } = await invoiceService.listInvoices(
      req.user.tenantId,
      {
        ...pagination,
        status,
        search,
        dateFrom: dateFrom || startDate,
        dateTo: dateTo || endDate,
        minAmount,
        maxAmount,
      }
    );
    const meta = buildPaginationMeta(pagination.page, pagination.limit, total);
    return paginated(res, invoices, meta);
  }

  async getById(req, res) {
    const invoice = await invoiceService.getInvoiceById(req.params.id, req.user.tenantId);
    return success(res, { invoice });
  }

  async update(req, res) {
    const auditContext = getAuditContext(req);
    const invoice = await invoiceService.updateInvoice(
      req.params.id, req.user.tenantId, req.user.userId, req.body, { auditContext }
    );
    return success(res, { invoice });
  }

  async markAsSent(req, res) {
    const auditContext = getAuditContext(req);
    const invoice = await invoiceService.markAsSent(
      req.params.id, req.user.tenantId, req.user.userId, req.body, { auditContext }
    );
    return success(res, { invoice });
  }

  async recordPayment(req, res) {
    const auditContext = getAuditContext(req);
    const invoice = await invoiceService.recordPayment(
      req.params.id, req.user.tenantId, req.user.userId, req.body, { auditContext }
    );
    return success(res, { invoice });
  }

  async bulkCancel(req, res) {
    const auditContext = getAuditContext(req);
    const result = await invoiceService.bulkCancelInvoices(
      req.body.ids, req.user.tenantId, req.user.userId, { auditContext }
    );
    return success(res, result);
  }

  async cancel(req, res) {
    const auditContext = getAuditContext(req);
    const invoice = await invoiceService.cancelInvoice(
      req.params.id, req.user.tenantId, req.user.userId, { auditContext }
    );
    return success(res, { invoice });
  }

  async bulkDelete(req, res) {
    const auditContext = getAuditContext(req);
    const result = await invoiceService.bulkDeleteInvoices(
      req.body.ids, req.user.tenantId, req.user.userId, { auditContext }
    );
    return success(res, result);
  }

  async delete(req, res) {
    const auditContext = getAuditContext(req);
    await invoiceService.deleteInvoice(
      req.params.id, req.user.tenantId, req.user.userId, { auditContext }
    );
    return success(res, { message: 'Invoice deleted' });
  }
}

module.exports = new InvoiceController();
