'use strict';

const exchangeRateService = require('./exchange-rate.service');
const {
  success,
  created,
  paginated,
  parsePagination,
  buildPaginationMeta,
} = require('../../common/utils/response');

class ExchangeRateController {
  async list(req, res) {
    const pagination = parsePagination(req.query);
    const { exchangeRates, total } = await exchangeRateService.listExchangeRates(
      req.user.tenantId,
      {
        ...pagination,
        from: req.query.from,
        to: req.query.to,
        source: req.query.source,
        isActive: req.query.isActive,
      }
    );
    const meta = buildPaginationMeta(pagination.page, pagination.limit, total);

    return paginated(res, exchangeRates, meta);
  }

  async create(req, res) {
    const exchangeRate = await exchangeRateService.createExchangeRate(
      req.user.tenantId,
      req.user.userId,
      req.body
    );

    return created(res, { exchangeRate });
  }

  async latest(req, res) {
    const exchangeRate = await exchangeRateService.getLatestExchangeRate(
      req.user.tenantId,
      {
        from: req.query.from,
        to: req.query.to,
        date: req.query.date,
      }
    );

    return success(res, { exchangeRate });
  }

  async update(req, res) {
    const exchangeRate = await exchangeRateService.updateExchangeRate(
      req.user.tenantId,
      req.params.id,
      req.body
    );

    return success(res, { exchangeRate });
  }

  async deactivate(req, res) {
    const exchangeRate = await exchangeRateService.deactivateExchangeRate(
      req.user.tenantId,
      req.params.id
    );

    return success(res, { exchangeRate });
  }
}

module.exports = new ExchangeRateController();
