'use strict';

const currencyService = require('./currency.service');
const { success, created } = require('../../common/utils/response');

class CurrencyController {
  async list(req, res) {
    const currencies = await currencyService.listCurrencies({
      isActive: req.query.isActive,
    });

    return success(res, { currencies });
  }

  async getByCode(req, res) {
    const currency = await currencyService.getCurrencyByCode(req.params.code);
    return success(res, { currency });
  }

  async create(req, res) {
    const currency = await currencyService.createCurrency(req.body);
    return created(res, { currency });
  }

  async update(req, res) {
    const currency = await currencyService.updateCurrency(req.params.code, req.body);
    return success(res, { currency });
  }
}

module.exports = new CurrencyController();
