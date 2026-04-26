'use strict';

const billService = require('./bill.service');
const { getAuditContext } = require('../../common/utils/audit');
const { sendCSV } = require('../../common/utils/csv');
const {
  success,
  created,
  paginated,
  parsePagination,
  buildPaginationMeta,
} = require('../../common/utils/response');

const BILL_EXPORT_FIELDS = [
  'billNumber',
  'supplierName',
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

function toExportRows(bills) {
  return bills.map((bill) => ({
    billNumber: bill.billNumber || '',
    supplierName: bill.supplierName || '',
    status: bill.status || '',
    total: formatNumericValue(bill.total),
    paidAmount: formatNumericValue(bill.paidAmount),
    remainingAmount: formatNumericValue(bill.remainingAmount),
    issueDate: formatDateValue(bill.issueDate),
    dueDate: formatDateValue(bill.dueDate),
  }));
}

class BillController {
  async create(req, res) {
    const auditContext = getAuditContext(req);
    const bill = await billService.createBill(
      req.user.tenantId,
      req.user.userId,
      req.body,
      { auditContext }
    );
    return created(res, { bill });
  }

  async list(req, res) {
    const listParams = buildListParams(req.query, true);
    const { bills, total } = await billService.listBills(
      req.user.tenantId,
      listParams
    );
    const meta = buildPaginationMeta(listParams.page, listParams.limit, total);
    return paginated(res, bills, meta);
  }

  async exportList(req, res) {
    const bills = await billService.exportBills(
      req.user.tenantId,
      buildListParams(req.query)
    );

    return sendCSV(res, toExportRows(bills), 'bills.csv', BILL_EXPORT_FIELDS);
  }

  async getById(req, res) {
    const bill = await billService.getBillById(req.params.id, req.user.tenantId);
    return success(res, { bill });
  }

  async update(req, res) {
    const auditContext = getAuditContext(req);
    const bill = await billService.updateBill(
      req.params.id,
      req.user.tenantId,
      req.user.userId,
      req.body,
      { auditContext }
    );
    return success(res, { bill });
  }

  async post(req, res) {
    const auditContext = getAuditContext(req);
    const bill = await billService.postBill(
      req.params.id,
      req.user.tenantId,
      req.user.userId,
      req.body,
      { auditContext }
    );
    return success(res, { bill });
  }

  async recordPayment(req, res) {
    const auditContext = getAuditContext(req);
    const bill = await billService.recordPayment(
      req.params.id,
      req.user.tenantId,
      req.user.userId,
      req.body,
      { auditContext }
    );
    return success(res, { bill });
  }

  async bulkCancel(req, res) {
    const auditContext = getAuditContext(req);
    const result = await billService.bulkCancelBills(
      req.body.ids,
      req.user.tenantId,
      req.user.userId,
      { auditContext }
    );
    return success(res, result);
  }

  async cancel(req, res) {
    const auditContext = getAuditContext(req);
    const bill = await billService.cancelBill(
      req.params.id,
      req.user.tenantId,
      req.user.userId,
      { auditContext }
    );
    return success(res, { bill });
  }
}

module.exports = new BillController();
