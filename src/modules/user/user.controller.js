'use strict';

const userService = require('./user.service');
const { getAuditContext } = require('../../common/utils/audit');
const { success, created, paginated } = require('../../common/utils/response');
const { parsePagination, buildPaginationMeta } = require('../../common/utils/response');

class UserController {
  async list(req, res) {
    const pagination = parsePagination(req.query);
    const { users, total } = await userService.listUsers(req.user.tenantId, pagination);
    const meta = buildPaginationMeta(pagination.page, pagination.limit, total);
    return paginated(res, users, meta);
  }

  async getById(req, res) {
    const user = await userService.getUserById(req.params.id, req.user.tenantId);
    return success(res, { user });
  }

  async getProfile(req, res) {
    const user = await userService.getProfile(req.user.userId, req.user.tenantId);
    return success(res, { user });
  }

  async invite(req, res) {
    const auditContext = getAuditContext(req);
    const result = await userService.inviteUser(
      req.user.tenantId,
      req.user.userId,
      req.body,
      { auditContext }
    );
    return created(res, result);
  }

  async changeRole(req, res) {
    const auditContext = getAuditContext(req);
    const user = await userService.changeUserRole(
      req.params.id,
      req.user.tenantId,
      req.user.userId,
      req.body,
      { auditContext }
    );
    return success(res, { user });
  }

  async deactivate(req, res) {
    const auditContext = getAuditContext(req);
    const user = await userService.deactivateUser(
      req.params.id,
      req.user.tenantId,
      req.user.userId,
      { auditContext }
    );
    return success(res, { user });
  }

  async updateProfile(req, res) {
    const auditContext = getAuditContext(req);
    const user = await userService.updateProfile(
      req.user.userId,
      req.user.tenantId,
      req.body,
      { auditContext }
    );
    return success(res, { user });
  }
}

module.exports = new UserController();
