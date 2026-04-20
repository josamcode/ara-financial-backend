'use strict';

const journalService = require('./journal.service');
const { getAuditContext } = require('../../common/utils/audit');
const { success, created, paginated } = require('../../common/utils/response');
const { parsePagination, buildPaginationMeta } = require('../../common/utils/response');
const { sendCSV } = require('../../common/utils/csv');

class JournalController {
  async create(req, res) {
    const auditContext = getAuditContext(req);
    const entry = await journalService.createEntry(
      req.user.tenantId, req.user.userId, req.body, { auditContext }
    );
    return created(res, { entry });
  }

  async list(req, res) {
    const pagination = parsePagination(req.query);
    const { startDate, endDate, accountId, status, search } = req.query;
    const { entries, total } = await journalService.listEntries(
      req.user.tenantId,
      { ...pagination, startDate, endDate, accountId, status, search }
    );
    const meta = buildPaginationMeta(pagination.page, pagination.limit, total);
    return paginated(res, entries, meta);
  }

  async getById(req, res) {
    const entry = await journalService.getEntryById(req.params.id, req.user.tenantId);
    return success(res, { entry });
  }

  async update(req, res) {
    const auditContext = getAuditContext(req);
    const entry = await journalService.updateEntry(
      req.params.id, req.user.tenantId, req.user.userId, req.body, { auditContext }
    );
    return success(res, { entry });
  }

  async post(req, res) {
    const auditContext = getAuditContext(req);
    const entry = await journalService.postEntry(
      req.params.id, req.user.tenantId, req.user.userId, { auditContext }
    );
    return success(res, { entry });
  }

  async reverse(req, res) {
    const auditContext = getAuditContext(req);
    const entry = await journalService.reverseEntry(
      req.params.id, req.user.tenantId, req.user.userId, { auditContext }
    );
    return created(res, { entry });
  }

  async delete(req, res) {
    const auditContext = getAuditContext(req);
    await journalService.deleteEntry(
      req.params.id, req.user.tenantId, req.user.userId, { auditContext }
    );
    return success(res, { message: 'Entry deleted' });
  }

  async exportCSV(req, res) {
    const { startDate, endDate, accountId, status } = req.query;
    const { entries } = await journalService.listEntries(
      req.user.tenantId,
      { page: 1, limit: 10000, skip: 0, startDate, endDate, accountId, status }
    );

    // Flatten entries for CSV
    const rows = [];
    for (const entry of entries) {
      const entryJson = entry.toJSON();
      for (const line of entryJson.lines) {
        rows.push({
          entryNumber: entryJson.entryNumber,
          date: entryJson.date,
          description: entryJson.description,
          reference: entryJson.reference,
          status: entryJson.status,
          accountId: line.accountId,
          debit: line.debit,
          credit: line.credit,
          lineDescription: line.description,
        });
      }
    }

    return sendCSV(res, rows, 'journal-entries.csv');
  }
}

module.exports = new JournalController();
