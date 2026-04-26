'use strict';

const taxService = require('./tax.service');
const {
  success,
  created,
  paginated,
  parsePagination,
  buildPaginationMeta,
} = require('../../common/utils/response');

function parseBooleanFilter(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

class TaxController {
  async list(req, res) {
    const pagination = parsePagination(req.query);
    const { taxRates, total } = await taxService.listTaxRates(req.user.tenantId, {
      type: req.query.type,
      isActive: parseBooleanFilter(req.query.isActive),
      search: req.query.search,
      ...pagination,
    });

    const meta = buildPaginationMeta(pagination.page, pagination.limit, total);
    return paginated(res, taxRates, meta);
  }

  async getById(req, res) {
    const taxRate = await taxService.getTaxRateById(req.params.id, req.user.tenantId);
    return success(res, { taxRate });
  }

  async create(req, res) {
    const taxRate = await taxService.createTaxRate(
      req.user.tenantId,
      req.user.userId,
      req.body
    );
    return created(res, { taxRate });
  }

  async update(req, res) {
    const taxRate = await taxService.updateTaxRate(
      req.params.id,
      req.user.tenantId,
      req.user.userId,
      req.body
    );
    return success(res, { taxRate });
  }

  async delete(req, res) {
    await taxService.deleteTaxRate(req.params.id, req.user.tenantId, req.user.userId);
    return success(res, { message: 'Tax rate deleted' });
  }
}

module.exports = new TaxController();
