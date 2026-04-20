'use strict';

const fiscalPeriodService = require('./fiscalPeriod.service');
const { getAuditContext } = require('../../common/utils/audit');
const { success, created } = require('../../common/utils/response');

class FiscalPeriodController {
  async list(req, res) {
    const periods = await fiscalPeriodService.listPeriods(req.user.tenantId, req.query);
    return success(res, periods);
  }

  async getById(req, res) {
    const period = await fiscalPeriodService.getPeriodById(req.params.id, req.user.tenantId);
    return success(res, { period });
  }

  async createYear(req, res) {
    const auditContext = getAuditContext(req);
    const periods = await fiscalPeriodService.createFiscalYear(req.user.tenantId, req.body, {
      userId: req.user.userId,
      auditContext,
    });
    return created(res, { periods, count: periods.length });
  }

  async close(req, res) {
    const auditContext = getAuditContext(req);
    const period = await fiscalPeriodService.closePeriod(
      req.params.id,
      req.user.tenantId,
      req.user.userId,
      { auditContext }
    );
    return success(res, { period });
  }

  async lock(req, res) {
    const auditContext = getAuditContext(req);
    const period = await fiscalPeriodService.lockPeriod(
      req.params.id,
      req.user.tenantId,
      req.user.userId,
      { auditContext }
    );
    return success(res, { period });
  }

  async reopen(req, res) {
    const auditContext = getAuditContext(req);
    const period = await fiscalPeriodService.reopenPeriod(req.params.id, req.user.tenantId, {
      userId: req.user.userId,
      auditContext,
    });
    return success(res, { period });
  }
}

module.exports = new FiscalPeriodController();
