'use strict';

const paymentService = require('./payment.service');
const { getAuditContext } = require('../../common/utils/audit');
const {
  success,
  created,
  paginated,
  parsePagination,
  buildPaginationMeta,
} = require('../../common/utils/response');

const controller = {
  async list(req, res) {
    const params = {
      ...parsePagination(req.query),
      status: req.query.status,
      provider: req.query.provider,
      referenceType: req.query.referenceType,
      referenceId: req.query.referenceId,
    };
    const { paymentAttempts, total } = await paymentService.listPaymentAttempts(
      req.tenantId,
      params
    );
    const meta = buildPaginationMeta(params.page, params.limit, total);

    return paginated(res, paymentAttempts, meta);
  },

  async getById(req, res) {
    const paymentAttempt = await paymentService.getPaymentAttemptById(
      req.tenantId,
      req.params.id
    );

    return success(res, { paymentAttempt });
  },

  async createMyFatoorahPayment(req, res) {
    const result = await paymentService.createMyFatoorahPayment(
      req.tenantId,
      req.user.userId,
      req.body,
      { auditContext: getAuditContext(req) }
    );

    return created(res, result);
  },

  async verify(req, res) {
    const result = await paymentService.verifyPaymentAttempt(
      req.tenantId,
      req.user.userId,
      req.params.id,
      { auditContext: getAuditContext(req) }
    );

    return success(res, result);
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
