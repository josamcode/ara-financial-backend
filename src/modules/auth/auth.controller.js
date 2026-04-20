'use strict';

const authService = require('./auth.service');
const config = require('../../config');
const { getAuditContext } = require('../../common/utils/audit');
const { success, created } = require('../../common/utils/response');

function sanitizePasswordResetResponse(result) {
  if (config.auth.exposeEmailActionTokens) {
    return result;
  }

  return {
    message: result.message,
  };
}

class AuthController {
  async register(req, res) {
    const auditContext = getAuditContext(req);
    const result = await authService.register(req.body, { auditContext });
    return created(res, result);
  }

  async login(req, res) {
    const auditContext = getAuditContext(req);
    const result = await authService.login(req.body, req.ip, { auditContext });
    return success(res, result);
  }

  async acceptInvite(req, res) {
    const auditContext = getAuditContext(req);
    const result = await authService.acceptInvite(req.body, { auditContext });
    return success(res, result);
  }

  async forgotPassword(req, res) {
    const auditContext = getAuditContext(req);
    const result = await authService.requestPasswordReset(req.body, { auditContext });
    return success(res, sanitizePasswordResetResponse(result));
  }

  async resetPassword(req, res) {
    const auditContext = getAuditContext(req);
    const result = await authService.resetPassword(req.body, { auditContext });
    return success(res, result);
  }

  async refresh(req, res) {
    const { refreshToken } = req.body;
    const auditContext = getAuditContext(req);
    const tokens = await authService.refresh(refreshToken, { auditContext });
    return success(res, tokens);
  }

  async logout(req, res) {
    const { refreshToken } = req.body;
    const auditContext = getAuditContext(req);
    await authService.logout(req.user.userId, refreshToken, { auditContext });
    return success(res, { message: 'Logged out successfully' });
  }

  async me(req, res) {
    const user = await authService.getCurrentUser(req.user.userId, req.user.tenantId);
    return success(res, { user });
  }
}

module.exports = new AuthController();
