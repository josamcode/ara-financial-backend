'use strict';

const dashboardService = require('./dashboard.service');
const { success } = require('../../common/utils/response');

class DashboardController {
  async getSummary(req, res) {
    const [financials, stats] = await Promise.all([
      dashboardService.getSummary(req.user.tenantId),
      dashboardService.getStats(req.user.tenantId),
    ]);
    return success(res, { financials, stats });
  }
}

module.exports = new DashboardController();
