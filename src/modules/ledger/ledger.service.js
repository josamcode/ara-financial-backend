'use strict';

const mongoose = require('mongoose');
const { JournalEntry } = require('../journal/journal.model');
const { Account } = require('../account/account.model');
const { toScaledInteger, formatScaledInteger } = require('../../common/utils/money');
const { NotFoundError } = require('../../common/errors');

class LedgerService {
  /**
   * Get general ledger for a specific account.
   *
   * Returns paginated movements with a running balance computed using
   * BigInt arithmetic to avoid floating-point errors.
   *
   * Running balance rule:
   *   debit-normal  → delta = debit − credit
   *   credit-normal → delta = credit − debit
   */
  async getAccountLedger(tenantId, accountId, { startDate, endDate, page, limit, skip }) {
    const tenantOid = new mongoose.Types.ObjectId(tenantId);
    const accountOid = new mongoose.Types.ObjectId(accountId);

    // 1. Validate account exists and belongs to this tenant
    const account = await Account.findOne({ _id: accountOid, tenantId: tenantOid })
      .select('code nameAr nameEn type nature')
      .lean();

    if (!account) {
      throw new NotFoundError('Account not found');
    }

    const accountNature = account.nature === 'credit' ? 'credit' : 'debit';

    // 2. Compute opening balance — sum of all posted movements BEFORE startDate
    //    This is zero when no startDate is specified (showing full history).
    let openingBalance = 0n;
    if (startDate) {
      const result = await JournalEntry.aggregate([
        {
          $match: {
            tenantId: tenantOid,
            status: 'posted',
            deletedAt: null,
            date: { $lt: new Date(startDate) },
          },
        },
        { $unwind: '$lines' },
        { $match: { 'lines.accountId': accountOid } },
        {
          $group: {
            _id: null,
            totalDebit: { $sum: '$lines.debit' },
            totalCredit: { $sum: '$lines.credit' },
          },
        },
      ]);

      if (result.length > 0) {
        const d = toScaledInteger(result[0].totalDebit.toString());
        const c = toScaledInteger(result[0].totalCredit.toString());
        openingBalance = this._calculateBalanceDelta(accountNature, d, c);
      }
    }

    // 3. Build the match stage for movements within the requested date range
    const matchStage = {
      tenantId: tenantOid,
      status: 'posted',
      deletedAt: null,
    };

    if (startDate || endDate) {
      matchStage.date = {};
      if (startDate) matchStage.date.$gte = new Date(startDate);
      if (endDate) matchStage.date.$lte = new Date(endDate);
    }

    // 4. Canonical pipeline: match → unwind → filter line → sort → project
    //    Sorting is: date ASC then entryNumber ASC (chronological, then by entry)
    const basePipeline = [
      { $match: matchStage },
      { $unwind: '$lines' },
      { $match: { 'lines.accountId': accountOid } },
      { $sort: { date: 1, entryNumber: 1 } },
      {
        $project: {
          _id: 0,
          entryNumber: 1,
          date: 1,
          description: 1,
          reference: 1,
          debit: '$lines.debit',
          credit: '$lines.credit',
          lineDescription: '$lines.description',
        },
      },
    ];

    // 5. Count total movements in range
    const countResult = await JournalEntry.aggregate([...basePipeline, { $count: 'total' }]);
    const total = countResult.length > 0 ? countResult[0].total : 0;

    // 6. Fetch current page
    const rawMovements = await JournalEntry.aggregate([
      ...basePipeline,
      { $skip: skip },
      { $limit: limit },
    ]);

    // 7. Compute the balance carried into the current page
    //    = openingBalance + sum of the `skip` movements that precede this page
    let runningBalance = openingBalance;
    if (skip > 0 && total > 0) {
      const priorResult = await JournalEntry.aggregate([
        ...basePipeline,
        { $limit: skip },
        {
          $group: {
            _id: null,
            totalDebit: { $sum: '$debit' },
            totalCredit: { $sum: '$credit' },
          },
        },
      ]);

      if (priorResult.length > 0) {
        const d = toScaledInteger(priorResult[0].totalDebit.toString());
        const c = toScaledInteger(priorResult[0].totalCredit.toString());
        runningBalance += this._calculateBalanceDelta(accountNature, d, c);
      }
    }

    // 8. Map rows, accumulating running balance with BigInt arithmetic
    const movements = rawMovements.map((m) => {
      const debit = toScaledInteger(m.debit.toString());
      const credit = toScaledInteger(m.credit.toString());
      runningBalance += this._calculateBalanceDelta(accountNature, debit, credit);

      return {
        date: m.date,
        entryNumber: m.entryNumber,
        description: m.lineDescription || m.description,
        reference: m.reference || null,
        debit: formatScaledInteger(debit),
        credit: formatScaledInteger(credit),
        runningBalance: formatScaledInteger(runningBalance),
      };
    });

    return {
      account: {
        _id: account._id,
        code: account.code,
        nameAr: account.nameAr,
        nameEn: account.nameEn,
        type: account.type,
        nature: accountNature,
      },
      openingBalance: formatScaledInteger(openingBalance),
      movements,
      total,
    };
  }

  /**
   * Get movements across all accounts (admin / all-ledger view).
   */
  async getAllAccountsLedger(tenantId, { startDate, endDate, page, limit, skip }) {
    const tenantOid = new mongoose.Types.ObjectId(tenantId);
    const matchStage = {
      tenantId: tenantOid,
      status: 'posted',
      deletedAt: null,
    };

    if (startDate || endDate) {
      matchStage.date = {};
      if (startDate) matchStage.date.$gte = new Date(startDate);
      if (endDate) matchStage.date.$lte = new Date(endDate);
    }

    const pipeline = [
      { $match: matchStage },
      { $unwind: '$lines' },
      {
        $lookup: {
          from: 'accounts',
          localField: 'lines.accountId',
          foreignField: '_id',
          as: 'accountInfo',
        },
      },
      { $unwind: '$accountInfo' },
      { $sort: { date: -1, entryNumber: -1 } },
      {
        $project: {
          _id: 0,
          entryNumber: 1,
          date: 1,
          description: 1,
          accountCode: '$accountInfo.code',
          accountNameAr: '$accountInfo.nameAr',
          accountNameEn: '$accountInfo.nameEn',
          debit: { $toString: '$lines.debit' },
          credit: { $toString: '$lines.credit' },
        },
      },
    ];

    const countResult = await JournalEntry.aggregate([
      ...pipeline.slice(0, 4),
      { $count: 'total' },
    ]);
    const total = countResult.length > 0 ? countResult[0].total : 0;

    const movements = await JournalEntry.aggregate([
      ...pipeline,
      { $skip: skip },
      { $limit: limit },
    ]);

    return { movements, total };
  }

  _calculateBalanceDelta(accountNature, debit, credit) {
    return accountNature === 'credit' ? credit - debit : debit - credit;
  }
}

module.exports = new LedgerService();
