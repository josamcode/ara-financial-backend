'use strict';

const billService = require('./bill.service');
const { getAuditContext } = require('../../common/utils/audit');
const {
  success,
  created,
  paginated,
  parsePagination,
  buildPaginationMeta,
} = require('../../common/utils/response');

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
    const pagination = parsePagination(req.query);
    const { status, search, startDate, endDate } = req.query;
    const { bills, total } = await billService.listBills(
      req.user.tenantId,
      { ...pagination, status, search, startDate, endDate }
    );
    const meta = buildPaginationMeta(pagination.page, pagination.limit, total);
    return paginated(res, bills, meta);
  }

  async getById(req, res) {
    const bill = await billService.getBillById(req.params.id, req.user.tenantId);
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
