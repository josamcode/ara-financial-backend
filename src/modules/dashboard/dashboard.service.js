'use strict';

const mongoose = require('mongoose');
const { JournalEntry } = require('../journal/journal.model');
const {
  toScaledInteger,
  formatScaledInteger,
} = require('../../common/utils/money');

/**
 * Dashboard service providing summary data for the main dashboard.
 */
class DashboardService {
  /**
   * Get dashboard summary: total assets, liabilities, equity, revenue, expenses.
   */
  async getSummary(tenantId) {
    const matchStage = {
      tenantId: new mongoose.Types.ObjectId(tenantId),
      status: 'posted',
      deletedAt: null,
    };

    const pipeline = [
      { $match: matchStage },
      { $unwind: '$lines' },
      {
        $lookup: {
          from: 'accounts',
          localField: 'lines.accountId',
          foreignField: '_id',
          as: 'account',
        },
      },
      { $unwind: '$account' },
      {
        $group: {
          _id: {
            type: '$account.type',
            nature: '$account.nature',
          },
          totalDebit: { $sum: '$lines.debit' },
          totalCredit: { $sum: '$lines.credit' },
        },
      },
    ];

    const results = await JournalEntry.aggregate(pipeline);

    const summary = {
      assets: 0n,
      liabilities: 0n,
      equity: 0n,
      revenue: 0n,
      expenses: 0n,
    };

    for (const item of results) {
      const debit = toScaledInteger(item.totalDebit.toString());
      const credit = toScaledInteger(item.totalCredit.toString());

      let balance;
      if (item._id.nature === 'debit') {
        balance = debit - credit;
      } else {
        balance = credit - debit;
      }

      if (summary[item._id.type] !== undefined) {
        summary[item._id.type] += balance;
      }
    }

    // Format values
    const netIncome = summary.revenue - summary.expenses;
    return {
      totalAssets: formatScaledInteger(summary.assets),
      totalLiabilities: formatScaledInteger(summary.liabilities),
      totalEquity: formatScaledInteger(summary.equity),
      totalRevenue: formatScaledInteger(summary.revenue),
      totalExpenses: formatScaledInteger(summary.expenses),
      netIncome: formatScaledInteger(netIncome),
    };
  }

  /**
   * Get entry statistics.
   */
  async getStats(tenantId) {
    const tid = new mongoose.Types.ObjectId(tenantId);
    const activeEntryFilter = {
      tenantId: tid,
      deletedAt: null,
    };

    const [totalEntries, draftEntries, postedEntries, recentEntries] =
      await Promise.all([
        JournalEntry.countDocuments(activeEntryFilter),
        JournalEntry.countDocuments({ ...activeEntryFilter, status: 'draft' }),
        JournalEntry.countDocuments({ ...activeEntryFilter, status: 'posted' }),
        JournalEntry.find(activeEntryFilter)
          .sort({ createdAt: -1 })
          .limit(5)
          .select('entryNumber date description status createdAt')
          .lean(),
      ]);

    return {
      totalEntries,
      draftEntries,
      postedEntries,
      recentEntries,
    };
  }
}

module.exports = new DashboardService();
