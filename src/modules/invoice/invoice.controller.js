'use strict';

const invoiceService = require('./invoice.service');
const { getAuditContext } = require('../../common/utils/audit');
const { sendCSV } = require('../../common/utils/csv');
const { success, created, paginated, parsePagination, buildPaginationMeta } = require('../../common/utils/response');

const INVOICE_EXPORT_FIELDS = [
  'invoiceNumber',
  'customerName',
  'status',
  'total',
  'paidAmount',
  'remainingAmount',
  'issueDate',
  'dueDate',
];

function buildListParams(query, includePagination = false) {
  const params = {
    status: query.status,
    search: query.search,
    dateFrom: query.dateFrom || query.startDate,
    dateTo: query.dateTo || query.endDate,
    minAmount: query.minAmount,
    maxAmount: query.maxAmount,
  };

  return includePagination
    ? { ...parsePagination(query), ...params }
    : params;
}

function formatDateValue(value) {
  if (!value) return '';

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function formatNumericValue(value) {
  if (value === null || value === undefined) return '';
  return typeof value?.toString === 'function' ? value.toString() : String(value);
}

function toExportRows(invoices) {
  return invoices.map((invoice) => ({
    invoiceNumber: invoice.invoiceNumber || '',
    customerName: invoice.customerName || '',
    status: invoice.status || '',
    total: formatNumericValue(invoice.total),
    paidAmount: formatNumericValue(invoice.paidAmount),
    remainingAmount: formatNumericValue(invoice.remainingAmount),
    issueDate: formatDateValue(invoice.issueDate),
    dueDate: formatDateValue(invoice.dueDate),
  }));
}

class InvoiceController {
  async create(req, res) {
    const auditContext = getAuditContext(req);
    const invoice = await invoiceService.createInvoice(
      req.user.tenantId, req.user.userId, req.body, { auditContext }
    );
    return created(res, { invoice });
  }

  async list(req, res) {
    const listParams = buildListParams(req.query, true);
    const { invoices, total } = await invoiceService.listInvoices(
      req.user.tenantId,
      listParams
    );
    const meta = buildPaginationMeta(listParams.page, listParams.limit, total);
    return paginated(res, invoices, meta);
  }

  async exportList(req, res) {
    const invoices = await invoiceService.exportInvoices(
      req.user.tenantId,
      buildListParams(req.query)
    );

    return sendCSV(res, toExportRows(invoices), 'invoices.csv', INVOICE_EXPORT_FIELDS);
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

  async emailInvoice(req, res) {
    const auditContext = getAuditContext(req);
    await invoiceService.emailInvoice(
      req.params.id, req.user.tenantId, req.user.userId, { auditContext }
    );
    return success(res, { message: 'Email sent' });
  }
}

module.exports = new InvoiceController();
