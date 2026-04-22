'use strict';

const tenantService = require('./tenant.service');
const { getAuditContext } = require('../../common/utils/audit');
const { success } = require('../../common/utils/response');

class TenantController {
  async get(req, res) {
    const tenant = await tenantService.getTenant(req.user.tenantId);
    return success(res, { tenant });
  }

  async updateSettings(req, res) {
    const auditContext = getAuditContext(req);
    const tenant = await tenantService.updateSettings(req.user.tenantId, req.body, {
      userId: req.user.userId,
      auditContext,
    });
    return success(res, { tenant });
  }

  async uploadLogo(req, res) {
    const auditContext = getAuditContext(req);
    const tenant = await tenantService.uploadLogo(req.user.tenantId, req.file, {
      userId: req.user.userId,
      auditContext,
    });
    return success(res, { tenant });
  }

  async completeSetup(req, res) {
    const auditContext = getAuditContext(req);
    const tenant = await tenantService.completeSetup(req.user.tenantId, {
      userId: req.user.userId,
      auditContext,
    });
    return success(res, { tenant });
  }
}

module.exports = new TenantController();
