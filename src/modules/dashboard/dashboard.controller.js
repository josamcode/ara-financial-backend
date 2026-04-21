'use strict';

const dashboardService = require('./dashboard.service');
const { success } = require('../../common/utils/response');

class DashboardController {
  async getSummary(req, res) {
    const [financials, stats, arap, activity] = await Promise.all([
      dashboardService.getSummary(req.user.tenantId),
      dashboardService.getStats(req.user.tenantId),
      dashboardService.getARAPSummary(req.user.tenantId),
      dashboardService.getRecentActivity(req.user.tenantId),
    ]);
    return success(res, { financials, stats, arap, activity });
  }
}

module.exports = new DashboardController();
