'use strict';

const ledgerService = require('./ledger.service');
const { success, paginated, parsePagination, buildPaginationMeta } = require('../../common/utils/response');
const { sendCSV } = require('../../common/utils/csv');

class LedgerController {
  async getAccountLedger(req, res) {
    const pagination = parsePagination(req.query);
    const { startDate, endDate } = req.query;

    const { account, openingBalance, movements, total } = await ledgerService.getAccountLedger(
      req.user.tenantId,
      req.params.accountId,
      { startDate, endDate, ...pagination }
    );

    const paginationMeta = buildPaginationMeta(pagination.page, pagination.limit, total);

    return success(res, { account, openingBalance, movements }, { pagination: paginationMeta });
  }

  async getAllLedger(req, res) {
    const pagination = parsePagination(req.query);
    const { startDate, endDate } = req.query;

    const { movements, total } = await ledgerService.getAllAccountsLedger(
      req.user.tenantId,
      { startDate, endDate, ...pagination }
    );

    const paginationMeta = buildPaginationMeta(pagination.page, pagination.limit, total);
    return paginated(res, movements, paginationMeta);
  }

  async exportAccountLedger(req, res) {
    const { startDate, endDate } = req.query;

    const { movements } = await ledgerService.getAccountLedger(
      req.user.tenantId,
      req.params.accountId,
      { startDate, endDate, page: 1, limit: 50000, skip: 0 }
    );

    return sendCSV(res, movements, `ledger-${req.params.accountId}.csv`);
  }
}

module.exports = new LedgerController();
