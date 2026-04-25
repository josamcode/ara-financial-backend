'use strict';

const paymentService = require('./payment.service');
const { getAuditContext } = require('../../common/utils/audit');
const { success, created } = require('../../common/utils/response');

const controller = {
  async createMyFatoorahPayment(req, res) {
    const result = await paymentService.createMyFatoorahPayment(
      req.tenantId,
      req.user.userId,
      req.body,
      { auditContext: getAuditContext(req) }
    );

    return created(res, result);
  },

  async handleMyFatoorahCallback(req, res) {
    const result = await paymentService.handleMyFatoorahCallback(req.query, {
      auditContext: getAuditContext(req),
    });

    return success(res, result);
  },

  async handleMyFatoorahError(req, res) {
    const result = await paymentService.handleMyFatoorahError(req.query, {
      auditContext: getAuditContext(req),
    });

    return success(res, result);
  },
};

module.exports = controller;
