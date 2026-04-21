'use strict';

const mongoose = require('mongoose');
const { JournalEntry } = require('../journal/journal.model');
const { Invoice } = require('../invoice/invoice.model');
const { Bill } = require('../bill/bill.model');
const { resolveInvoiceStatus } = require('../invoice/invoice-status');
const { resolveBillStatus } = require('../bill/bill-status');
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
   * Get AR/AP outstanding balances and overdue counts.
   */
  async getARAPSummary(tenantId) {
    const tid = new mongoose.Types.ObjectId(tenantId);
    const today = new Date();
    const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

    const arFilter = { tenantId: tid, status: { $in: ['sent', 'partially_paid'] }, remainingAmount: { $gt: 0 }, deletedAt: null };
    const apFilter = { tenantId: tid, status: { $in: ['posted', 'partially_paid'] }, remainingAmount: { $gt: 0 }, deletedAt: null };

    const [arResult, apResult, overdueInvoices, overdueBills] = await Promise.all([
      Invoice.aggregate([
        { $match: arFilter },
        { $group: { _id: null, total: { $sum: '$remainingAmount' } } },
      ]),
      Bill.aggregate([
        { $match: apFilter },
        { $group: { _id: null, total: { $sum: '$remainingAmount' } } },
      ]),
      Invoice.countDocuments({ ...arFilter, dueDate: { $lt: todayStart } }),
      Bill.countDocuments({ ...apFilter, dueDate: { $lt: todayStart } }),
    ]);

    return {
      arOutstanding: arResult[0]?.total ?? 0,
      apOutstanding: apResult[0]?.total ?? 0,
      overdueInvoices,
      overdueBills,
    };
  }

  /**
   * Get recent invoices and bills for activity feed.
   */
  async getRecentActivity(tenantId) {
    const tid = new mongoose.Types.ObjectId(tenantId);

    const [rawInvoices, rawBills] = await Promise.all([
      Invoice.find({ tenantId: tid, deletedAt: null })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('invoiceNumber customerName total remainingAmount paidAmount status dueDate issueDate')
        .lean(),
      Bill.find({ tenantId: tid, deletedAt: null })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('billNumber supplierName total remainingAmount paidAmount status dueDate issueDate')
        .lean(),
    ]);

    const recentInvoices = rawInvoices.map((inv) => {
      const total = inv.total?.toString() ?? '0';
      const remainingAmount = inv.remainingAmount ?? 0;
      const paidAmount = inv.paidAmount ?? 0;
      return {
        _id: inv._id,
        invoiceNumber: inv.invoiceNumber,
        customerName: inv.customerName,
        total,
        remainingAmount,
        status: resolveInvoiceStatus({ ...inv, total, remainingAmount, paidAmount }),
        dueDate: inv.dueDate,
        issueDate: inv.issueDate,
      };
    });

    const recentBills = rawBills.map((bill) => {
      const total = bill.total?.toString() ?? '0';
      const remainingAmount = bill.remainingAmount ?? 0;
      const paidAmount = bill.paidAmount ?? 0;
      return {
        _id: bill._id,
        billNumber: bill.billNumber,
        supplierName: bill.supplierName,
        total,
        remainingAmount,
        status: resolveBillStatus({ ...bill, total, remainingAmount, paidAmount }),
        dueDate: bill.dueDate,
        issueDate: bill.issueDate,
      };
    });

    return { recentInvoices, recentBills };
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
