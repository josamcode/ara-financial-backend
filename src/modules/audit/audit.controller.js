'use strict';

const auditService = require('./audit.service');
const { paginated } = require('../../common/utils/response');
const { parsePagination, buildPaginationMeta } = require('../../common/utils/response');

class AuditController {
  async list(req, res) {
    const pagination = parsePagination(req.query);
    const { action, resourceType, resourceId, userId, startDate, endDate } = req.query;
    const { logs, total } = await auditService.getLogs(
      req.user.tenantId,
      { ...pagination, action, resourceType, resourceId, userId, startDate, endDate }
    );
    const meta = buildPaginationMeta(pagination.page, pagination.limit, total);
    return paginated(res, logs, meta);
  }
}

module.exports = new AuditController();
