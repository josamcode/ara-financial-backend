'use strict';

const billingService = require('./billing.service');
const { getAuditContext } = require('../../common/utils/audit');
const { success, created } = require('../../common/utils/response');

const controller = {
  async listPlans(_req, res) {
    const plans = await billingService.listActivePlans();
    return success(res, { plans });
  },

  async getSubscription(req, res) {
    const subscription = await billingService.getCurrentSubscription(req.tenantId);
    return success(res, { subscription });
  },

  async checkout(req, res) {
    const result = await billingService.checkout(
      req.tenantId,
      req.user.userId,
      req.body,
      { auditContext: getAuditContext(req) }
    );

    return created(res, result);
  },

  async syncPayment(req, res) {
    const result = await billingService.syncPayment(
      req.tenantId,
      req.user.userId,
      req.params.paymentAttemptId,
      { auditContext: getAuditContext(req) }
    );

    return success(res, result);
  },
};

module.exports = controller;
