'use strict';

const accountService = require('./account.service');
const { getAuditContext } = require('../../common/utils/audit');
const { success, created, paginated } = require('../../common/utils/response');
const { parsePagination, buildPaginationMeta } = require('../../common/utils/response');

class AccountController {
  async list(req, res) {
    const pagination = parsePagination(req.query);
    const { type, isActive, isParentOnly, search } = req.query;
    const { accounts, total } = await accountService.listAccounts(
      req.user.tenantId,
      {
        type,
        isActive: isActive === 'true' ? true : isActive === 'false' ? false : undefined,
        isParentOnly: isParentOnly === 'true' ? true : isParentOnly === 'false' ? false : undefined,
        search,
        ...pagination,
      }
    );
    const meta = buildPaginationMeta(pagination.page, pagination.limit, total);
    return paginated(res, accounts, meta);
  }

  async tree(req, res) {
    const tree = await accountService.getAccountTree(req.user.tenantId);
    return success(res, tree);
  }

  async getById(req, res) {
    const account = await accountService.getAccountById(req.params.id, req.user.tenantId);
    return success(res, { account });
  }

  async create(req, res) {
    const auditContext = getAuditContext(req);
    const account = await accountService.createAccount(req.user.tenantId, req.body, {
      userId: req.user.userId,
      auditContext,
    });
    return created(res, { account });
  }

  async update(req, res) {
    const auditContext = getAuditContext(req);
    const account = await accountService.updateAccount(req.params.id, req.user.tenantId, req.body, {
      userId: req.user.userId,
      auditContext,
    });
    return success(res, { account });
  }

  async delete(req, res) {
    const auditContext = getAuditContext(req);
    await accountService.deleteAccount(req.params.id, req.user.tenantId, {
      userId: req.user.userId,
      auditContext,
    });
    return success(res, { message: 'Account deleted' });
  }

  async applyTemplate(req, res) {
    const auditContext = getAuditContext(req);
    const count = await accountService.applyTemplate(req.user.tenantId, 'egyptian', {
      userId: req.user.userId,
      auditContext,
    });
    return created(res, { message: `Template applied: ${count} accounts created`, count });
  }
}

module.exports = new AccountController();
