'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../../config');
const logger = require('../../config/logger');
const { getRedisClient } = require('../../config/redis');
const { JournalEntry } = require('../journal/journal.model');
const { Account } = require('../account/account.model');
const { FiscalPeriod } = require('../fiscal-period/fiscalPeriod.model');
const { Invoice } = require('../invoice/invoice.model');
const { Bill } = require('../bill/bill.model');
const { TaxRate } = require('../tax/tax-rate.model');
const Tenant = require('../tenant/tenant.model');
const {
  COLLECTIBLE_INVOICE_STATUSES,
} = require('../invoice/invoice-status');
const {
  PAYABLE_BILL_STATUSES,
  resolveBillRemainingAmount,
} = require('../bill/bill-status');
const fiscalPeriodService = require('../fiscal-period/fiscalPeriod.service');
const { BadRequestError } = require('../../common/errors');
const {
  toScaledInteger,
  formatScaledInteger,
} = require('../../common/utils/money');

const REPORT_CACHE_PREFIX = 'report:';
const CURRENT_YEAR_EARNINGS_CODE = '3300';
const RETAINED_EARNINGS_CODE = '3200';
const CASH_ACCOUNT_PREFIXES = ['111'];
const AR_AGING_ELIGIBLE_STATUSES = ['sent', 'partially_paid', 'overdue'];
const AP_AGING_ELIGIBLE_STATUSES = PAYABLE_BILL_STATUSES;
const FOREIGN_CURRENCY_BALANCES_WARNING = 'FOREIGN_CURRENCY_BALANCES_UNSUPPORTED';
const VAT_INVOICE_STATUSES = Object.freeze([
  ...new Set([...COLLECTIBLE_INVOICE_STATUSES, 'paid']),
]);
const VAT_BILL_STATUSES = Object.freeze([
  ...new Set([...PAYABLE_BILL_STATUSES, 'paid']),
]);

const WORKING_CAPITAL_RULES = Object.freeze([
  { code: '1120', label: 'Accounts Receivable', section: 'operating', multiplier: -1n },
  { code: '1130', label: 'Inventory', section: 'operating', multiplier: -1n },
  { code: '1140', label: 'Prepaid Expenses', section: 'operating', multiplier: -1n },
  { code: '2110', label: 'Accounts Payable', section: 'operating', multiplier: 1n },
  { code: '2120', label: 'Accrued Expenses', section: 'operating', multiplier: 1n },
  { code: '2130', label: 'Unearned Revenue', section: 'operating', multiplier: 1n },
  { code: '2140', label: 'VAT Payable', section: 'operating', multiplier: 1n },
]);

function toObjectId(value) {
  return new mongoose.Types.ObjectId(value);
}

function hashValue(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function isValidDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function isDateOnlyInput(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function isMidnightUtcTimestampInput(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value.trim())
  );
}

function toIsoString(date) {
  return date.toISOString();
}

function toPeriodRange(startDate, endDate) {
  return {
    startDate: toIsoString(startDate),
    endDate: toIsoString(endDate),
  };
}

class ReportService {
  async getTrialBalance(tenantId, params = {}) {
    const primaryParams = this._normalizeTrialBalanceParams(params);
    const report = await this._getTrialBalanceReport(tenantId, primaryParams);

    if (!primaryParams.compare) {
      return report;
    }

    const comparison = await this._getTrialBalanceReport(tenantId, primaryParams.compare);
    return this._attachComparison(report, comparison, {
      entryFields: [{ key: 'balance', comparisonKey: 'comparisonBalance', deltaKey: 'deltaBalance' }],
      totalsFields: ['totalDebits', 'totalCredits', 'difference'],
      collectionKeys: ['accounts'],
      comparisonPeriodKey: 'period',
    });
  }

  async getIncomeStatement(tenantId, params = {}) {
    const primaryParams = this._normalizeRequiredRangeParams(params, 'Income Statement');
    const report = await this._getIncomeStatementReport(tenantId, primaryParams);

    if (!primaryParams.compare) {
      return report;
    }

    const comparison = await this._getIncomeStatementReport(tenantId, primaryParams.compare);
    return this._attachComparison(report, comparison, {
      entryFields: [{ key: 'balance', comparisonKey: 'comparisonBalance', deltaKey: 'deltaBalance' }],
      totalsFields: ['totalRevenue', 'totalExpenses', 'netIncome'],
      collectionKeys: ['revenue', 'expenses'],
      comparisonPeriodKey: 'period',
    });
  }

  async getBalanceSheet(tenantId, params = {}) {
    const primaryParams = this._normalizeAsOfParams(params);
    const report = await this._getBalanceSheetReport(tenantId, primaryParams);

    if (!primaryParams.compare) {
      return report;
    }

    const comparison = await this._getBalanceSheetReport(tenantId, primaryParams.compare);
    return this._attachComparison(report, comparison, {
      entryFields: [{ key: 'balance', comparisonKey: 'comparisonBalance', deltaKey: 'deltaBalance' }],
      totalsFields: ['totalAssets', 'totalLiabilities', 'totalEquity', 'totalLiabilitiesAndEquity'],
      collectionKeys: ['assets', 'liabilities', 'equity'],
      comparisonPeriodKey: 'asOfDate',
    });
  }

  async getCashFlowStatement(tenantId, params = {}) {
    const primaryParams = this._normalizeRequiredRangeParams(params, 'Cash Flow Statement');
    const report = await this._getCashFlowReport(tenantId, primaryParams);

    if (!primaryParams.compare) {
      return report;
    }

    const comparison = await this._getCashFlowReport(tenantId, primaryParams.compare);
    return this._attachComparison(report, comparison, {
      entryFields: [{ key: 'amount', comparisonKey: 'comparisonAmount', deltaKey: 'deltaAmount' }],
      totalsFields: [
        'operatingCashFlow',
        'investingCashFlow',
        'financingCashFlow',
        'reconcilingDifference',
        'netIncreaseInCash',
        'openingCash',
        'closingCash',
      ],
      collectionKeys: ['operating', 'investing', 'financing', 'reconcilingItems'],
      comparisonPeriodKey: 'period',
    });
  }

  async getARAging(tenantId, params = {}) {
    const primaryParams = this._normalizeOptionalAsOfParams(params, 'AR Aging');

    return this._getCachedReport('ar-aging', tenantId, primaryParams, async () => {
      const baseCurrency = await this._getTenantBaseCurrency(tenantId);
      const invoices = await Invoice.find({
        tenantId,
        deletedAt: null,
        status: { $in: AR_AGING_ELIGIBLE_STATUSES },
      })
        .select('invoiceNumber customerId customerName issueDate dueDate total paidAmount remainingAmount status currency documentCurrency baseCurrency')
        .lean();

      const customerRows = new Map();
      const foreignDocuments = [];
      let totalOutstanding = 0n;
      let overdueInvoicesCount = 0;

      for (const invoice of invoices) {
        if (this._isForeignCurrencyDocument(invoice, baseCurrency)) {
          foreignDocuments.push(this._formatUnsupportedForeignDocument(invoice, {
            idField: 'invoiceId',
            numberField: 'invoiceNumber',
            fallbackBaseCurrency: baseCurrency,
          }));
          continue;
        }

        const remainingAmount = this._resolveInvoiceRemainingScaledAmount(invoice);
        if (remainingAmount <= 0n) {
          continue;
        }

        const customerId = invoice.customerId?.toString?.() ?? null;
        const customerName = invoice.customerName || '—';
        const customerKey = customerId || `name:${customerName}`;
        const referenceDate = invoice.dueDate || invoice.issueDate;
        const daysPastDue = this._getDaysPastDue(primaryParams.asOfDate, referenceDate);
        const bucketKey = this._getARAgingBucketKey(daysPastDue);

        if (!customerRows.has(customerKey)) {
          customerRows.set(customerKey, {
            customerId,
            customerName,
            days0_30: 0n,
            days31_60: 0n,
            days61_90: 0n,
            days90Plus: 0n,
            totalOutstanding: 0n,
          });
        }

        const row = customerRows.get(customerKey);
        row[bucketKey] += remainingAmount;
        row.totalOutstanding += remainingAmount;
        totalOutstanding += remainingAmount;

        if (daysPastDue > 0) {
          overdueInvoicesCount += 1;
        }
      }

      const rows = Array.from(customerRows.values())
        .sort((left, right) => (
          left.customerName.localeCompare(right.customerName)
          || String(left.customerId || '').localeCompare(String(right.customerId || ''))
        ))
        .map((row) => ({
          customerId: row.customerId,
          customerName: row.customerName,
          days0_30: formatScaledInteger(row.days0_30),
          days31_60: formatScaledInteger(row.days31_60),
          days61_90: formatScaledInteger(row.days61_90),
          days90Plus: formatScaledInteger(row.days90Plus),
          totalOutstanding: formatScaledInteger(row.totalOutstanding),
        }));

      return {
        summary: {
          totalOutstanding: formatScaledInteger(totalOutstanding),
          customersWithOutstanding: rows.length,
          overdueInvoicesCount,
          excludedForeignDocumentsCount: foreignDocuments.length,
        },
        rows,
        asOfDate: toIsoString(primaryParams.asOfDate),
        currency: baseCurrency,
        amountsIn: 'baseCurrency',
        warnings: this._buildForeignCurrencyBalanceWarnings('AR aging', foreignDocuments),
      };
    });
  }

  async getAPAging(tenantId, params = {}) {
    const primaryParams = this._normalizeOptionalAsOfParams(params, 'AP Aging');

    return this._getCachedReport('ap-aging', tenantId, primaryParams, async () => {
      const baseCurrency = await this._getTenantBaseCurrency(tenantId);
      const bills = await Bill.find({
        tenantId,
        deletedAt: null,
        status: { $in: AP_AGING_ELIGIBLE_STATUSES },
      })
        .select('supplierId supplierName issueDate dueDate total paidAmount remainingAmount status currency documentCurrency baseCurrency billNumber')
        .lean();

      const supplierRows = new Map();
      const foreignDocuments = [];
      let totalOutstanding = 0n;
      let overdueBillsCount = 0;

      for (const bill of bills) {
        if (this._isForeignCurrencyDocument(bill, baseCurrency)) {
          foreignDocuments.push(this._formatUnsupportedForeignDocument(bill, {
            idField: 'billId',
            numberField: 'billNumber',
            fallbackBaseCurrency: baseCurrency,
          }));
          continue;
        }

        const remainingAmount = this._resolveBillRemainingScaledAmount(bill);
        if (remainingAmount <= 0n) {
          continue;
        }

        const supplierId = bill.supplierId?.toString?.() ?? null;
        const supplierName = bill.supplierName || '-';
        const supplierKey = supplierId || `name:${supplierName}`;
        const referenceDate = bill.dueDate || bill.issueDate;
        const daysPastDue = this._getDaysPastDue(primaryParams.asOfDate, referenceDate);
        const bucketKey = this._getARAgingBucketKey(daysPastDue);

        if (!supplierRows.has(supplierKey)) {
          supplierRows.set(supplierKey, {
            supplierId,
            supplierName,
            days0_30: 0n,
            days31_60: 0n,
            days61_90: 0n,
            days90Plus: 0n,
            totalOutstanding: 0n,
          });
        }

        const row = supplierRows.get(supplierKey);
        row[bucketKey] += remainingAmount;
        row.totalOutstanding += remainingAmount;
        totalOutstanding += remainingAmount;

        if (daysPastDue > 0) {
          overdueBillsCount += 1;
        }
      }

      const rows = Array.from(supplierRows.values())
        .sort((left, right) => (
          left.supplierName.localeCompare(right.supplierName)
          || String(left.supplierId || '').localeCompare(String(right.supplierId || ''))
        ))
        .map((row) => ({
          supplierId: row.supplierId,
          supplierName: row.supplierName,
          days0_30: formatScaledInteger(row.days0_30),
          days31_60: formatScaledInteger(row.days31_60),
          days61_90: formatScaledInteger(row.days61_90),
          days90Plus: formatScaledInteger(row.days90Plus),
          totalOutstanding: formatScaledInteger(row.totalOutstanding),
        }));

      return {
        summary: {
          totalOutstanding: formatScaledInteger(totalOutstanding),
          suppliersWithOutstanding: rows.length,
          overdueBillsCount,
          excludedForeignDocumentsCount: foreignDocuments.length,
        },
        rows,
        asOfDate: toIsoString(primaryParams.asOfDate),
        currency: baseCurrency,
        amountsIn: 'baseCurrency',
        warnings: this._buildForeignCurrencyBalanceWarnings('AP aging', foreignDocuments),
      };
    });
  }

  async getVatReturn(tenantId, params = {}) {
    const primaryParams = this._normalizeVatReturnParams(params);

    return this._getCachedReport('vat-return', tenantId, primaryParams, async () => {
      const baseCurrency = await this._getTenantBaseCurrency(tenantId);
      const [invoices, bills] = await Promise.all([
        this._findVatInvoices(tenantId, primaryParams),
        this._findVatBills(tenantId, primaryParams),
      ]);

      const groups = new Map();
      const salesGroups = new Map();
      const purchaseGroups = new Map();
      const taxRateIds = new Set();
      const sales = this._collectVatDocumentLines({
        documents: invoices,
        kind: 'sales',
        includeDetails: primaryParams.includeDetails,
        taxRateId: primaryParams.taxRateId,
        groups,
        sideGroups: salesGroups,
        taxRateIds,
        baseCurrency,
      });
      const purchases = this._collectVatDocumentLines({
        documents: bills,
        kind: 'purchases',
        includeDetails: primaryParams.includeDetails,
        taxRateId: primaryParams.taxRateId,
        groups,
        sideGroups: purchaseGroups,
        taxRateIds,
        baseCurrency,
      });

      const taxRatesById = await this._getTaxRateNamesById(tenantId, Array.from(taxRateIds));
      const outputVAT = sales.taxAmount;
      const inputVAT = purchases.taxAmount;
      const netVAT = outputVAT - inputVAT;
      const netVatStatus = this._getVatReturnStatus(netVAT);
      const report = {
        period: toPeriodRange(primaryParams.startDate, primaryParams.endDate),
        basis: 'accrual',
        currency: baseCurrency,
        amountsIn: 'baseCurrency',
        summary: {
          outputVAT: formatScaledInteger(outputVAT),
          inputVAT: formatScaledInteger(inputVAT),
          netVAT: formatScaledInteger(netVAT),
          status: netVatStatus,
        },
        outputVat: {
          taxableAmount: formatScaledInteger(sales.taxableAmount),
          taxAmount: formatScaledInteger(outputVAT),
          byRate: this._formatVatRateBreakdown(salesGroups, taxRatesById),
        },
        inputVat: {
          taxableAmount: formatScaledInteger(purchases.taxableAmount),
          taxAmount: formatScaledInteger(inputVAT),
          byRate: this._formatVatRateBreakdown(purchaseGroups, taxRatesById),
        },
        netVat: {
          amount: formatScaledInteger(netVAT),
          status: netVatStatus,
        },
        documents: {
          salesInvoicesCount: sales.documentsCount,
          purchaseBillsCount: purchases.documentsCount,
        },
        breakdown: this._formatVatBreakdown(groups, taxRatesById),
      };

      if (primaryParams.includeDetails) {
        report.details = {
          sales: sales.details,
          purchases: purchases.details,
        };
      }

      return report;
    });
  }

  async _getTrialBalanceReport(tenantId, params) {
    return this._getCachedReport('trial-balance', tenantId, params, async () => {
      const matchStage = {
        tenantId: toObjectId(tenantId),
        status: 'posted',
        deletedAt: null,
      };

      if (params.startDate || params.endDate) {
        matchStage.date = {};
        if (params.startDate) matchStage.date.$gte = params.startDate;
        if (params.endDate) matchStage.date.$lte = params.endDate;
      }

      const pipeline = [
        { $match: matchStage },
        { $unwind: '$lines' },
        {
          $group: {
            _id: '$lines.accountId',
            totalDebit: { $sum: '$lines.debit' },
            totalCredit: { $sum: '$lines.credit' },
          },
        },
        {
          $lookup: {
            from: 'accounts',
            localField: '_id',
            foreignField: '_id',
            as: 'account',
          },
        },
        { $unwind: '$account' },
        {
          $project: {
            accountId: '$_id',
            code: '$account.code',
            nameAr: '$account.nameAr',
            nameEn: '$account.nameEn',
            type: '$account.type',
            nature: '$account.nature',
            totalDebit: { $toString: '$totalDebit' },
            totalCredit: { $toString: '$totalCredit' },
            balance: {
              $toString: { $subtract: ['$totalDebit', '$totalCredit'] },
            },
          },
        },
        { $sort: { code: 1 } },
      ];

      const accounts = await JournalEntry.aggregate(pipeline);

      let totalDebits = 0n;
      let totalCredits = 0n;
      for (const account of accounts) {
        totalDebits += toScaledInteger(account.totalDebit);
        totalCredits += toScaledInteger(account.totalCredit);
      }

      const difference = totalDebits - totalCredits;

      return {
        accounts,
        totals: {
          totalDebits: formatScaledInteger(totalDebits),
          totalCredits: formatScaledInteger(totalCredits),
          difference: formatScaledInteger(difference),
          isBalanced: difference === 0n,
        },
        period: {
          startDate: params.startDate ? toIsoString(params.startDate) : null,
          endDate: params.endDate ? toIsoString(params.endDate) : null,
        },
      };
    });
  }

  async _getIncomeStatementReport(tenantId, params) {
    return this._getCachedReport('income-statement', tenantId, params, async () => {
      const results = await this._aggregateIncomeStatementLines(
        tenantId,
        params.startDate,
        params.endDate
      );

      const revenue = [];
      const expenses = [];
      let totalRevenue = 0n;
      let totalExpenses = 0n;

      for (const item of results) {
        const debit = toScaledInteger(item.totalDebit);
        const credit = toScaledInteger(item.totalCredit);
        const balance = item._id.type === 'revenue'
          ? credit - debit
          : debit - credit;

        const entry = {
          accountId: item._id.accountId,
          code: item._id.code,
          nameAr: item._id.nameAr,
          nameEn: item._id.nameEn,
          balance: formatScaledInteger(balance),
        };

        if (item._id.type === 'revenue') {
          revenue.push(entry);
          totalRevenue += balance;
        } else {
          expenses.push(entry);
          totalExpenses += balance;
        }
      }

      const netIncome = totalRevenue - totalExpenses;

      return {
        revenue,
        expenses,
        totals: {
          totalRevenue: formatScaledInteger(totalRevenue),
          totalExpenses: formatScaledInteger(totalExpenses),
          netIncome: formatScaledInteger(netIncome),
          isProfit: netIncome >= 0n,
        },
        period: toPeriodRange(params.startDate, params.endDate),
      };
    });
  }

  async _getBalanceSheetReport(tenantId, params) {
    return this._getCachedReport('balance-sheet', tenantId, params, async () => {
      const [results, yearClose] = await Promise.all([
        this._aggregateBalanceSnapshot(tenantId, params.asOfDate),
        this._getYearCloseContext(tenantId, params.asOfDate),
      ]);

      const assets = [];
      const liabilities = [];
      const equity = [];
      let totalAssets = 0n;
      let totalLiabilities = 0n;
      let totalEquity = 0n;

      for (const item of results) {
        const balance = toScaledInteger(item.balance);
        const entry = {
          accountId: item.accountId,
          code: item.code,
          nameAr: item.nameAr,
          nameEn: item.nameEn,
          balance: formatScaledInteger(balance),
        };

        if (item.type === 'asset') {
          assets.push(entry);
          totalAssets += balance;
        } else if (item.type === 'liability') {
          liabilities.push(entry);
          totalLiabilities += balance;
        } else {
          equity.push(entry);
          totalEquity += balance;
        }
      }

      const currentYearEarnings = await this._getNetIncomeForDateRange(
        tenantId,
        yearClose.currentFiscalYear.startDate,
        params.asOfDate
      );

      totalEquity = await this._applyCurrentYearEarnings(
        tenantId,
        equity,
        totalEquity,
        currentYearEarnings
      );

      const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;

      return {
        assets,
        liabilities,
        equity,
        totals: {
          totalAssets: formatScaledInteger(totalAssets),
          totalLiabilities: formatScaledInteger(totalLiabilities),
          totalEquity: formatScaledInteger(totalEquity),
          totalLiabilitiesAndEquity: formatScaledInteger(totalLiabilitiesAndEquity),
          isBalanced: totalAssets === totalLiabilitiesAndEquity,
        },
        asOfDate: toIsoString(params.asOfDate),
        yearClose: {
          currentFiscalYear: yearClose.currentFiscalYear.year,
          currentFiscalYearStartDate: toIsoString(yearClose.currentFiscalYear.startDate),
          currentFiscalYearEndDate: toIsoString(yearClose.currentFiscalYear.endDate),
          pendingPriorYearClosures: yearClose.pendingPriorYearClosures,
          retainedEarningsAccountCode: RETAINED_EARNINGS_CODE,
          currentYearEarningsAccountCode: CURRENT_YEAR_EARNINGS_CODE,
          policy:
            'Current year earnings are limited to the fiscal year containing the as-of date. ' +
            'Prior fiscal years should be closed into retained earnings before final reporting.',
        },
      };
    });
  }

  async _getCashFlowReport(tenantId, params) {
    return this._getCachedReport('cash-flow', tenantId, params, async () => {
      const periodIncome = await this._getIncomeStatementReport(tenantId, params);
      const openingDate = new Date(params.startDate.getTime() - 1);
      const [openingSnapshot, closingSnapshot] = await Promise.all([
        this._aggregateBalanceSnapshot(tenantId, openingDate),
        this._aggregateBalanceSnapshot(tenantId, params.endDate),
      ]);

      const openingMap = new Map(openingSnapshot.map((entry) => [entry.code, entry]));
      const closingMap = new Map(closingSnapshot.map((entry) => [entry.code, entry]));

      const operating = [];
      const investing = [];
      const financing = [];
      const reconcilingItems = [];

      let operatingCashFlow = 0n;
      let investingCashFlow = 0n;
      let financingCashFlow = 0n;

      const netIncome = toScaledInteger(periodIncome.totals.netIncome);
      operating.push({
        code: 'OPERATING-NET-INCOME',
        nameEn: 'Net income',
        nameAr: 'صافي الربح',
        amount: formatScaledInteger(netIncome),
      });
      operatingCashFlow += netIncome;

      const depreciationAdjustment = periodIncome.expenses.find((entry) => entry.code === '5500');
      if (depreciationAdjustment) {
        const amount = toScaledInteger(depreciationAdjustment.balance);
        operating.push({
          code: 'OPERATING-DEPRECIATION',
          nameEn: 'Add back depreciation',
          nameAr: 'إضافة الإهلاك',
          amount: formatScaledInteger(amount),
        });
        operatingCashFlow += amount;
      }

      for (const rule of WORKING_CAPITAL_RULES) {
        const openingBalance = this._getSnapshotBalance(openingMap.get(rule.code));
        const closingBalance = this._getSnapshotBalance(closingMap.get(rule.code));
        const delta = closingBalance - openingBalance;
        const cashImpact = delta * rule.multiplier;

        if (cashImpact === 0n) {
          continue;
        }

        operating.push({
          code: `OPERATING-${rule.code}`,
          nameEn: rule.label,
          nameAr: rule.label,
          amount: formatScaledInteger(cashImpact),
        });
        operatingCashFlow += cashImpact;
      }

      for (const entry of closingSnapshot) {
        const openingBalance = this._getSnapshotBalance(openingMap.get(entry.code));
        const closingBalance = this._getSnapshotBalance(entry);
        const delta = closingBalance - openingBalance;

        if (delta === 0n) {
          continue;
        }

        if (this._isInvestingAccount(entry.code)) {
          const cashImpact = -delta;
          investing.push({
            code: `INVESTING-${entry.code}`,
            nameEn: entry.nameEn,
            nameAr: entry.nameAr,
            amount: formatScaledInteger(cashImpact),
          });
          investingCashFlow += cashImpact;
        } else if (this._isFinancingAccount(entry.code)) {
          const cashImpact = this._getFinancingCashImpact(entry.code, delta);
          financing.push({
            code: `FINANCING-${entry.code}`,
            nameEn: entry.nameEn,
            nameAr: entry.nameAr,
            amount: formatScaledInteger(cashImpact),
          });
          financingCashFlow += cashImpact;
        }
      }

      const openingCash = this._sumCashBalances(openingSnapshot);
      const closingCash = this._sumCashBalances(closingSnapshot);
      const actualNetIncreaseInCash = closingCash - openingCash;
      const reportedNetIncrease = operatingCashFlow + investingCashFlow + financingCashFlow;
      const reconcilingDifference = actualNetIncreaseInCash - reportedNetIncrease;

      if (reconcilingDifference !== 0n) {
        reconcilingItems.push({
          code: 'RECONCILING-UNCLASSIFIED',
          nameEn: 'Unclassified cash movements',
          nameAr: 'حركات نقدية غير مصنفة',
          amount: formatScaledInteger(reconcilingDifference),
        });
      }

      return {
        method: 'indirect',
        operating,
        investing,
        financing,
        reconcilingItems,
        totals: {
          operatingCashFlow: formatScaledInteger(operatingCashFlow),
          investingCashFlow: formatScaledInteger(investingCashFlow),
          financingCashFlow: formatScaledInteger(financingCashFlow),
          reconcilingDifference: formatScaledInteger(reconcilingDifference),
          netIncreaseInCash: formatScaledInteger(actualNetIncreaseInCash),
          openingCash: formatScaledInteger(openingCash),
          closingCash: formatScaledInteger(closingCash),
          isReconciled: reconcilingDifference === 0n,
        },
        period: toPeriodRange(params.startDate, params.endDate),
      };
    });
  }

  async _findVatInvoices(tenantId, params) {
    return Invoice.find(this._buildVatDocumentFilter(tenantId, params, VAT_INVOICE_STATUSES))
      .select('invoiceNumber customerName issueDate currency documentCurrency baseCurrency lineItems')
      .sort({ issueDate: 1, invoiceNumber: 1 })
      .lean();
  }

  async _findVatBills(tenantId, params) {
    return Bill.find(this._buildVatDocumentFilter(tenantId, params, VAT_BILL_STATUSES))
      .select('billNumber supplierName issueDate currency documentCurrency baseCurrency lineItems')
      .sort({ issueDate: 1, billNumber: 1 })
      .lean();
  }

  _buildVatDocumentFilter(tenantId, params, statuses) {
    const filter = {
      tenantId,
      deletedAt: null,
      status: { $in: statuses },
      issueDate: {
        $gte: params.startDate,
        $lte: params.endDate,
      },
    };

    if (params.taxRateId) {
      filter['lineItems.taxRateId'] = toObjectId(params.taxRateId);
    }

    return filter;
  }

  _collectVatDocumentLines({
    documents,
    kind,
    includeDetails,
    taxRateId,
    groups,
    sideGroups,
    taxRateIds,
    baseCurrency,
  }) {
    const details = [];
    let taxableAmount = 0n;
    let taxAmount = 0n;
    let documentsCount = 0;

    for (const document of documents) {
      let documentTaxableAmount = 0n;
      let documentTaxAmount = 0n;
      let documentTotal = 0n;
      const documentLineDetails = [];

      for (const line of document.lineItems || []) {
        const lineTaxRateId = line.taxRateId?.toString?.() || null;
        if (taxRateId && lineTaxRateId !== taxRateId) {
          continue;
        }

        const lineTaxRate = this._toScaledMoney(line.taxRate);
        const hasTaxClassification = Boolean(lineTaxRateId) || lineTaxRate > 0n;
        if (!hasTaxClassification) {
          continue;
        }

        const documentLineTaxAmount = this._toScaledMoney(line.taxAmount);
        const lineTaxAmount = this._resolveVatLineBaseAmount(document, line, {
          baseCurrency,
          baseField: 'lineBaseTaxAmount',
          documentField: 'taxAmount',
          requiresBaseAmount: documentLineTaxAmount > 0n,
        });

        const lineTaxableAmount = this._resolveVatLineBaseAmount(document, line, {
          baseCurrency,
          baseField: 'lineBaseSubtotal',
          documentField: 'lineSubtotal',
          requiresBaseAmount: true,
        });
        if (lineTaxableAmount <= 0n && lineTaxAmount <= 0n) {
          continue;
        }

        const lineTotal = this._resolveVatLineBaseAmount(document, line, {
          baseCurrency,
          baseField: 'lineBaseTotal',
          documentField: 'lineTotal',
          fallbackAmount: lineTaxableAmount + lineTaxAmount,
          requiresBaseAmount: true,
        });

        this._addVatBreakdownLine(groups, {
          taxRateId: lineTaxRateId,
          taxRate: lineTaxRate,
          kind,
          taxableAmount: lineTaxableAmount,
          documentId: document._id?.toString?.() ?? String(document._id),
          taxAmount: lineTaxAmount,
        });
        this._addVatRateLine(sideGroups, {
          taxRateId: lineTaxRateId,
          taxRate: lineTaxRate,
          taxableAmount: lineTaxableAmount,
          taxAmount: lineTaxAmount,
          documentId: document._id?.toString?.() ?? String(document._id),
        });

        if (lineTaxRateId) {
          taxRateIds.add(lineTaxRateId);
        }

        documentTaxableAmount += lineTaxableAmount;
        documentTaxAmount += lineTaxAmount;
        documentTotal += lineTotal;
        taxableAmount += lineTaxableAmount;
        taxAmount += lineTaxAmount;

        if (includeDetails) {
          documentLineDetails.push(this._formatVatLineDetail(line, {
            taxRateId: lineTaxRateId,
            taxRate: lineTaxRate,
            taxableAmount: lineTaxableAmount,
            taxAmount: lineTaxAmount,
            total: lineTotal,
          }));
        }
      }

      if (documentTaxableAmount > 0n || documentTaxAmount > 0n) {
        documentsCount += 1;
      }

      if (includeDetails && (documentTaxableAmount > 0n || documentTaxAmount > 0n)) {
        details.push(this._formatVatDetail(document, kind, {
          taxableAmount: documentTaxableAmount,
          taxAmount: documentTaxAmount,
          total: documentTotal,
          lines: documentLineDetails,
        }));
      }
    }

    return {
      taxableAmount,
      taxAmount,
      documentsCount,
      details,
    };
  }

  _resolveVatLineBaseAmount(
    document,
    line,
    {
      baseCurrency,
      baseField,
      documentField,
      fallbackAmount = 0n,
      requiresBaseAmount = false,
    }
  ) {
    const baseValue = line[baseField];
    const hasBaseValue = baseValue !== undefined && baseValue !== null;
    const baseAmount = hasBaseValue ? this._toScaledMoney(baseValue) : null;

    if (this._isForeignCurrencyDocument(document, baseCurrency)) {
      if (requiresBaseAmount && (baseAmount === null || baseAmount <= 0n)) {
        this._throwBaseAmountsRequiredForVat();
      }

      return baseAmount ?? 0n;
    }

    if (baseAmount !== null && baseAmount !== 0n) {
      return baseAmount;
    }

    if (line[documentField] !== undefined && line[documentField] !== null) {
      return this._toScaledMoney(line[documentField]);
    }

    return fallbackAmount;
  }

  _throwBaseAmountsRequiredForVat() {
    throw new BadRequestError(
      'Base currency amounts are required for foreign-currency VAT reporting',
      'BASE_AMOUNTS_REQUIRED'
    );
  }

  _addVatBreakdownLine(groups, { taxRateId, taxRate, kind, taxableAmount, taxAmount, documentId }) {
    const key = `${taxRateId || 'manual'}:${formatScaledInteger(taxRate, 6)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        taxRateId,
        taxRate,
        outputTaxableAmount: 0n,
        inputTaxableAmount: 0n,
        outputVAT: 0n,
        inputVAT: 0n,
        outputDocumentIds: new Set(),
        inputDocumentIds: new Set(),
      });
    }

    const group = groups.get(key);
    if (kind === 'sales') {
      group.outputTaxableAmount += taxableAmount;
      group.outputVAT += taxAmount;
      group.outputDocumentIds.add(documentId);
    } else {
      group.inputTaxableAmount += taxableAmount;
      group.inputVAT += taxAmount;
      group.inputDocumentIds.add(documentId);
    }
  }

  _addVatRateLine(groups, { taxRateId, taxRate, taxableAmount, taxAmount, documentId }) {
    const key = `${taxRateId || 'manual'}:${formatScaledInteger(taxRate, 6)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        taxRateId,
        taxRate,
        taxableAmount: 0n,
        taxAmount: 0n,
        documentIds: new Set(),
      });
    }

    const group = groups.get(key);
    group.taxableAmount += taxableAmount;
    group.taxAmount += taxAmount;
    group.documentIds.add(documentId);
  }

  async _getTaxRateNamesById(tenantId, taxRateIds) {
    if (!taxRateIds.length) {
      return new Map();
    }

    const taxRates = await TaxRate.find({
      tenantId,
      _id: { $in: taxRateIds.map((id) => toObjectId(id)) },
    })
      .select('name rate')
      .lean();

    return new Map(taxRates.map((taxRate) => [taxRate._id.toString(), taxRate]));
  }

  _formatVatBreakdown(groups, taxRatesById) {
    return Array.from(groups.values())
      .map((group) => {
        const taxRate = group.taxRateId ? taxRatesById.get(group.taxRateId) : null;
        const netVAT = group.outputVAT - group.inputVAT;

        return {
          taxRateId: group.taxRateId,
          taxRateName: taxRate?.name || (group.taxRateId ? 'Unknown tax rate' : 'Manual/unknown tax rate'),
          taxRate: formatScaledInteger(group.taxRate, 6),
          outputTaxableAmount: formatScaledInteger(group.outputTaxableAmount),
          inputTaxableAmount: formatScaledInteger(group.inputTaxableAmount),
          taxableAmount: formatScaledInteger(group.outputTaxableAmount - group.inputTaxableAmount),
          outputVAT: formatScaledInteger(group.outputVAT),
          inputVAT: formatScaledInteger(group.inputVAT),
          netVAT: formatScaledInteger(netVAT),
          outputDocumentsCount: group.outputDocumentIds.size,
          inputDocumentsCount: group.inputDocumentIds.size,
        };
      })
      .sort((left, right) => (
        left.taxRateName.localeCompare(right.taxRateName) ||
        left.taxRate.localeCompare(right.taxRate) ||
        String(left.taxRateId || '').localeCompare(String(right.taxRateId || ''))
      ));
  }

  _formatVatRateBreakdown(groups, taxRatesById) {
    return Array.from(groups.values())
      .map((group) => {
        const taxRate = group.taxRateId ? taxRatesById.get(group.taxRateId) : null;

        return {
          taxRateId: group.taxRateId,
          taxRateName: taxRate?.name || (group.taxRateId ? 'Unknown tax rate' : 'Manual/unknown tax rate'),
          taxRate: formatScaledInteger(group.taxRate, 6),
          taxableAmount: formatScaledInteger(group.taxableAmount),
          taxAmount: formatScaledInteger(group.taxAmount),
          documentsCount: group.documentIds.size,
        };
      })
      .sort((left, right) => (
        left.taxRateName.localeCompare(right.taxRateName) ||
        left.taxRate.localeCompare(right.taxRate) ||
        String(left.taxRateId || '').localeCompare(String(right.taxRateId || ''))
      ));
  }

  _formatVatLineDetail(line, totals) {
    return {
      lineId: line._id?.toString?.() ?? null,
      description: line.description || '',
      taxRateId: totals.taxRateId,
      taxRate: formatScaledInteger(totals.taxRate, 6),
      taxableAmount: formatScaledInteger(totals.taxableAmount),
      taxAmount: formatScaledInteger(totals.taxAmount),
      total: formatScaledInteger(totals.total),
    };
  }

  _formatVatDetail(document, kind, totals) {
    const base = {
      issueDate: toIsoString(document.issueDate),
      taxableAmount: formatScaledInteger(totals.taxableAmount),
      taxAmount: formatScaledInteger(totals.taxAmount),
      total: formatScaledInteger(totals.total),
      documentCurrency: this._getDocumentCurrency(document),
      baseCurrency: this._getDocumentBaseCurrency(document),
      lines: totals.lines,
    };

    if (kind === 'sales') {
      return {
        documentType: 'salesInvoice',
        documentId: document._id.toString(),
        documentNumber: document.invoiceNumber,
        invoiceId: document._id.toString(),
        invoiceNumber: document.invoiceNumber,
        date: base.issueDate,
        issueDate: base.issueDate,
        customerName: document.customerName || '-',
        taxableAmount: base.taxableAmount,
        taxAmount: base.taxAmount,
        total: base.total,
        documentCurrency: base.documentCurrency,
        baseCurrency: base.baseCurrency,
        lines: base.lines,
      };
    }

    return {
      documentType: 'purchaseBill',
      documentId: document._id.toString(),
      documentNumber: document.billNumber,
      billId: document._id.toString(),
      billNumber: document.billNumber,
      date: base.issueDate,
      issueDate: base.issueDate,
      supplierName: document.supplierName || '-',
      taxableAmount: base.taxableAmount,
      taxAmount: base.taxAmount,
      total: base.total,
      documentCurrency: base.documentCurrency,
      baseCurrency: base.baseCurrency,
      lines: base.lines,
    };
  }

  _getVatReturnStatus(netVAT) {
    if (netVAT > 0n) return 'payable';
    if (netVAT < 0n) return 'refundable';
    return 'zero';
  }

  async _aggregateIncomeStatementLines(tenantId, startDate, endDate) {
    const pipeline = [
      {
        $match: {
          tenantId: toObjectId(tenantId),
          status: 'posted',
          deletedAt: null,
          date: {
            $gte: startDate,
            $lte: endDate,
          },
        },
      },
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
        $match: {
          'account.type': { $in: ['revenue', 'expense'] },
        },
      },
      {
        $group: {
          _id: {
            accountId: '$lines.accountId',
            type: '$account.type',
            code: '$account.code',
            nameAr: '$account.nameAr',
            nameEn: '$account.nameEn',
          },
          totalDebit: { $sum: '$lines.debit' },
          totalCredit: { $sum: '$lines.credit' },
        },
      },
      { $sort: { '_id.code': 1 } },
    ];

    return JournalEntry.aggregate(pipeline);
  }

  async _aggregateBalanceSnapshot(tenantId, asOfDate) {
    const pipeline = [
      {
        $match: {
          tenantId: toObjectId(tenantId),
          status: 'posted',
          deletedAt: null,
          date: { $lte: asOfDate },
        },
      },
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
        $match: {
          'account.type': { $in: ['asset', 'liability', 'equity'] },
        },
      },
      {
        $group: {
          _id: {
            accountId: '$lines.accountId',
            type: '$account.type',
            code: '$account.code',
            nameAr: '$account.nameAr',
            nameEn: '$account.nameEn',
            nature: '$account.nature',
          },
          totalDebit: { $sum: '$lines.debit' },
          totalCredit: { $sum: '$lines.credit' },
        },
      },
      {
        $project: {
          accountId: '$_id.accountId',
          type: '$_id.type',
          code: '$_id.code',
          nameAr: '$_id.nameAr',
          nameEn: '$_id.nameEn',
          nature: '$_id.nature',
          balance: {
            $toString: {
              $cond: [
                { $eq: ['$_id.nature', 'debit'] },
                { $subtract: ['$totalDebit', '$totalCredit'] },
                { $subtract: ['$totalCredit', '$totalDebit'] },
              ],
            },
          },
        },
      },
      { $sort: { code: 1 } },
    ];

    return JournalEntry.aggregate(pipeline);
  }

  async _getNetIncomeForDateRange(tenantId, startDate, endDate) {
    const totals = await this._aggregateIncomeStatementLines(tenantId, startDate, endDate);
    let totalRevenue = 0n;
    let totalExpenses = 0n;

    for (const item of totals) {
      const debit = toScaledInteger(item.totalDebit);
      const credit = toScaledInteger(item.totalCredit);

      if (item._id.type === 'revenue') {
        totalRevenue += credit - debit;
      } else if (item._id.type === 'expense') {
        totalExpenses += debit - credit;
      }
    }

    return totalRevenue - totalExpenses;
  }

  async _applyCurrentYearEarnings(tenantId, equity, totalEquity, currentYearEarnings) {
    const existing = equity.find((entry) => entry.code === CURRENT_YEAR_EARNINGS_CODE);
    if (existing) {
      totalEquity -= toScaledInteger(existing.balance);
      existing.balance = formatScaledInteger(currentYearEarnings);
      totalEquity += currentYearEarnings;
      return totalEquity;
    }

    const currentYearAccount = await Account.findOne({
      tenantId,
      code: CURRENT_YEAR_EARNINGS_CODE,
    })
      .select('code nameAr nameEn')
      .lean();

    equity.push({
      accountId: currentYearAccount?._id || null,
      code: currentYearAccount?.code || CURRENT_YEAR_EARNINGS_CODE,
      nameAr: currentYearAccount?.nameAr || 'أرباح/خسائر العام',
      nameEn: currentYearAccount?.nameEn || 'Current Year Earnings',
      balance: formatScaledInteger(currentYearEarnings),
    });

    totalEquity += currentYearEarnings;
    return totalEquity;
  }

  async _getYearCloseContext(tenantId, asOfDate) {
    const currentPeriod = await fiscalPeriodService.findPeriodForDate(tenantId, asOfDate, {
      required: true,
    });

    const fiscalYearPeriods = await FiscalPeriod.find({
      tenantId,
      year: currentPeriod.year,
    }).sort({ startDate: 1 });

    const priorFiscalYearPeriods = await FiscalPeriod.find({
      tenantId,
      year: { $lt: currentPeriod.year },
    }).sort({ year: 1, startDate: 1 });

    const pendingPriorYearClosures = [];
    const priorYearStatusMap = new Map();

    for (const period of priorFiscalYearPeriods) {
      const year = period.year;
      const current = priorYearStatusMap.get(year) || { hasOpenPeriod: false };
      if (period.status === 'open') {
        current.hasOpenPeriod = true;
      }
      priorYearStatusMap.set(year, current);
    }

    for (const [year, status] of priorYearStatusMap.entries()) {
      if (status.hasOpenPeriod) {
        pendingPriorYearClosures.push(year);
      }
    }

    return {
      currentFiscalYear: {
        year: currentPeriod.year,
        startDate: fiscalYearPeriods[0].startDate,
        endDate: fiscalYearPeriods[fiscalYearPeriods.length - 1].endDate,
      },
      pendingPriorYearClosures,
    };
  }

  async _getCachedReport(reportKey, tenantId, params, computeFn) {
    const { refresh, compare, ...cacheInput } = params;
    if (refresh || config.report.cacheTtlSeconds <= 0) {
      return computeFn();
    }

    const redis = this._getCacheClient();
    if (!redis) {
      return computeFn();
    }

    let cacheKey = null;

    try {
      const version = await this._getReportCacheVersion(tenantId);
      cacheKey = [
        REPORT_CACHE_PREFIX,
        reportKey,
        tenantId,
        version,
        hashValue(cacheInput),
      ].join(':');

      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      logger.warn({ err: error, reportKey, tenantId }, 'Report cache unavailable, continuing uncached');
    }

    const report = await computeFn();

    if (cacheKey) {
      try {
        await redis.setex(cacheKey, config.report.cacheTtlSeconds, JSON.stringify(report));
      } catch (error) {
        logger.warn({ err: error, reportKey, tenantId }, 'Failed to store cached report');
      }
    }

    return report;
  }

  _getCacheClient() {
    try {
      return getRedisClient();
    } catch {
      return null;
    }
  }

  async _getReportCacheVersion(tenantId) {
    const [
      latestJournalEntry,
      latestAccount,
      latestFiscalPeriod,
      latestInvoice,
      latestBill,
      latestTaxRate,
    ] = await Promise.all([
      JournalEntry.findOne({ tenantId })
        .sort({ updatedAt: -1 })
        .select('updatedAt')
        .setOptions({ __includeDeleted: true }),
      Account.findOne({ tenantId })
        .sort({ updatedAt: -1 })
        .select('updatedAt')
        .setOptions({ __includeDeleted: true }),
      FiscalPeriod.findOne({ tenantId })
        .sort({ updatedAt: -1 })
        .select('updatedAt'),
      Invoice.findOne({ tenantId })
        .sort({ updatedAt: -1 })
        .select('updatedAt')
        .setOptions({ __includeDeleted: true }),
      Bill.findOne({ tenantId })
        .sort({ updatedAt: -1 })
        .select('updatedAt')
        .setOptions({ __includeDeleted: true }),
      TaxRate.findOne({ tenantId })
        .sort({ updatedAt: -1 })
        .select('updatedAt')
        .setOptions({ __includeDeleted: true }),
    ]);

    return [
      latestJournalEntry?.updatedAt?.toISOString() || 'nojournals',
      latestAccount?.updatedAt?.toISOString() || 'noaccounts',
      latestFiscalPeriod?.updatedAt?.toISOString() || 'noperiods',
      latestInvoice?.updatedAt?.toISOString() || 'noinvoices',
      latestBill?.updatedAt?.toISOString() || 'nobills',
      latestTaxRate?.updatedAt?.toISOString() || 'notaxrates',
    ].join('|');
  }

  _normalizeTrialBalanceParams(params) {
    const startDate = this._parseOptionalDate('Start date', params.startDate, 'start');
    const endDate = this._parseOptionalDate('End date', params.endDate, 'end');
    this._assertDateOrder(startDate, endDate, 'Trial Balance');

    const compare = this._buildOptionalComparisonRange(
      params.compareStartDate,
      params.compareEndDate,
      'Trial Balance comparison'
    );

    return {
      startDate,
      endDate,
      refresh: Boolean(params.refresh),
      compare,
    };
  }

  _normalizeRequiredRangeParams(params, reportName) {
    const startDate = this._parseRequiredDate('Start date', params.startDate, reportName, 'start');
    const endDate = this._parseRequiredDate('End date', params.endDate, reportName, 'end');
    this._assertDateOrder(startDate, endDate, reportName);

    const compare = this._buildOptionalComparisonRange(
      params.compareStartDate,
      params.compareEndDate,
      `${reportName} comparison`
    );

    return {
      startDate,
      endDate,
      refresh: Boolean(params.refresh),
      compare,
    };
  }

  _normalizeAsOfParams(params) {
    const asOfDate = this._parseRequiredDate('As-of date', params.asOfDate, 'Balance Sheet', 'end');
    const compareAsOfDate = params.compareAsOfDate
      ? this._parseRequiredDate('Comparison as-of date', params.compareAsOfDate, 'Balance Sheet', 'end')
      : null;

    return {
      asOfDate,
      refresh: Boolean(params.refresh),
      compare: compareAsOfDate ? { asOfDate: compareAsOfDate, refresh: Boolean(params.refresh) } : null,
    };
  }

  _normalizeOptionalAsOfParams(params, reportName) {
    const asOfDate = params.asOfDate
      ? this._parseRequiredDate('As-of date', params.asOfDate, reportName, 'end')
      : this._parseOptionalDate('As-of date', new Date().toISOString().slice(0, 10), 'end');

    return {
      asOfDate,
      refresh: Boolean(params.refresh),
    };
  }

  _normalizeVatReturnParams(params) {
    const startDate = this._parseRequiredDate('Start date', params.startDate, 'VAT Return', 'start');
    const endDate = this._parseRequiredDate('End date', params.endDate, 'VAT Return', 'end');
    this._assertDateOrder(startDate, endDate, 'VAT Return');

    const basis = params.basis || 'accrual';
    if (basis !== 'accrual') {
      throw new BadRequestError('VAT Return basis must be accrual');
    }

    const taxRateId = params.taxRateId ? params.taxRateId.toString() : null;
    if (taxRateId && !mongoose.Types.ObjectId.isValid(taxRateId)) {
      throw new BadRequestError('Tax rate ID must be a valid ObjectId');
    }

    return {
      startDate,
      endDate,
      includeDetails: params.includeDetails === true || params.includeDetails === 'true',
      taxRateId,
      basis,
      refresh: Boolean(params.refresh),
    };
  }

  _parseOptionalDate(label, value, boundary = 'start') {
    if (!value) {
      return null;
    }

    let parsed;
    if (isDateOnlyInput(value) || (boundary === 'end' && isMidnightUtcTimestampInput(value))) {
      const normalizedValue = value.slice(0, 10);
      parsed = boundary === 'end'
        ? new Date(`${normalizedValue}T23:59:59.999Z`)
        : new Date(`${normalizedValue}T00:00:00.000Z`);
    } else {
      parsed = new Date(value);
    }

    if (!isValidDate(parsed)) {
      throw new BadRequestError(`${label} must be a valid date`);
    }

    return parsed;
  }

  _parseRequiredDate(label, value, reportName, boundary = 'start') {
    if (!value) {
      throw new BadRequestError(`${label} is required for ${reportName}`);
    }

    return this._parseOptionalDate(label, value, boundary);
  }

  _assertDateOrder(startDate, endDate, reportName) {
    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestError(`${reportName} end date must be on or after the start date`);
    }
  }

  _buildOptionalComparisonRange(compareStartDateValue, compareEndDateValue, comparisonLabel) {
    const hasCompareStart = Boolean(compareStartDateValue);
    const hasCompareEnd = Boolean(compareEndDateValue);

    if (!hasCompareStart && !hasCompareEnd) {
      return null;
    }

    if (hasCompareStart !== hasCompareEnd) {
      throw new BadRequestError(`${comparisonLabel} requires both start and end dates`);
    }

    const compareStartDate = this._parseRequiredDate(
      'Comparison start date',
      compareStartDateValue,
      comparisonLabel,
      'start'
    );
    const compareEndDate = this._parseRequiredDate(
      'Comparison end date',
      compareEndDateValue,
      comparisonLabel,
      'end'
    );
    this._assertDateOrder(compareStartDate, compareEndDate, comparisonLabel);

    return {
      startDate: compareStartDate,
      endDate: compareEndDate,
      refresh: false,
    };
  }

  async _getTenantBaseCurrency(tenantId) {
    const tenant = await Tenant.findById(tenantId).select('baseCurrency').lean();
    return this._normalizeCurrencyCode(tenant?.baseCurrency, 'SAR');
  }

  _normalizeCurrencyCode(value, fallback = 'SAR') {
    const normalized = value?.toString?.().trim().toUpperCase();
    return /^[A-Z]{3}$/.test(normalized || '') ? normalized : fallback;
  }

  _getDocumentBaseCurrency(document, fallbackBaseCurrency = 'SAR') {
    return this._normalizeCurrencyCode(document?.baseCurrency, fallbackBaseCurrency);
  }

  _getDocumentCurrency(document, fallbackBaseCurrency = 'SAR') {
    const baseCurrency = this._getDocumentBaseCurrency(document, fallbackBaseCurrency);
    return this._normalizeCurrencyCode(
      document?.documentCurrency || document?.currency || baseCurrency,
      baseCurrency
    );
  }

  _isForeignCurrencyDocument(document, fallbackBaseCurrency = 'SAR') {
    const baseCurrency = this._getDocumentBaseCurrency(document, fallbackBaseCurrency);
    const documentCurrency = this._getDocumentCurrency(document, fallbackBaseCurrency);
    return documentCurrency !== baseCurrency;
  }

  _formatUnsupportedForeignDocument(document, { idField, numberField, fallbackBaseCurrency }) {
    return {
      [idField]: document._id?.toString?.() ?? document._id,
      [numberField]: document[numberField] || null,
      documentCurrency: this._getDocumentCurrency(document, fallbackBaseCurrency),
      baseCurrency: this._getDocumentBaseCurrency(document, fallbackBaseCurrency),
    };
  }

  _buildForeignCurrencyBalanceWarnings(reportName, documents) {
    if (!documents.length) {
      return [];
    }

    return [{
      code: FOREIGN_CURRENCY_BALANCES_WARNING,
      message: `${reportName} excludes foreign-currency documents because base paid amounts and FX gain/loss handling are not supported in this version`,
      count: documents.length,
      documents,
    }];
  }

  _attachComparison(primaryReport, comparisonReport, {
    entryFields,
    totalsFields,
    collectionKeys,
    comparisonPeriodKey,
  }) {
    const mergedReport = {
      ...primaryReport,
      comparison: {
        [comparisonPeriodKey]: comparisonReport[comparisonPeriodKey],
        totals: comparisonReport.totals,
        delta: this._buildTotalsDelta(primaryReport.totals, comparisonReport.totals, totalsFields),
      },
    };

    for (const collectionKey of collectionKeys) {
      mergedReport[collectionKey] = this._mergeEntries(
        primaryReport[collectionKey],
        comparisonReport[collectionKey],
        entryFields
      );
    }

    return mergedReport;
  }

  _mergeEntries(primaryEntries = [], comparisonEntries = [], entryFields) {
    const merged = new Map();

    for (const entry of primaryEntries) {
      const key = entry.code;
      const mergedEntry = { ...entry };

      for (const field of entryFields) {
        mergedEntry[field.comparisonKey] = null;
        mergedEntry[field.deltaKey] = entry[field.key];
      }

      merged.set(key, mergedEntry);
    }

    for (const entry of comparisonEntries) {
      const key = entry.code;
      const mergedEntry = merged.get(key) || {
        ...entry,
      };

      for (const field of entryFields) {
        const primaryValue = mergedEntry[field.key] || '0.00';
        const comparisonValue = entry[field.key] || '0.00';
        mergedEntry[field.key] = mergedEntry[field.key] || '0.00';
        mergedEntry[field.comparisonKey] = comparisonValue;
        mergedEntry[field.deltaKey] = formatScaledInteger(
          toScaledInteger(primaryValue) - toScaledInteger(comparisonValue)
        );
      }

      merged.set(key, mergedEntry);
    }

    return Array.from(merged.values()).sort((left, right) => left.code.localeCompare(right.code));
  }

  _buildTotalsDelta(primaryTotals, comparisonTotals, fields) {
    return fields.reduce((delta, field) => {
      delta[field] = formatScaledInteger(
        toScaledInteger(primaryTotals[field] || '0.00') -
        toScaledInteger(comparisonTotals[field] || '0.00')
      );
      return delta;
    }, {});
  }

  _toScaledMoney(value) {
    return toScaledInteger(value?.toString?.() ?? value ?? '0');
  }

  _getSnapshotBalance(entry) {
    if (!entry) {
      return 0n;
    }

    return toScaledInteger(entry.balance || '0.00');
  }

  _sumCashBalances(snapshot) {
    return snapshot
      .filter((entry) => this._isCashAccount(entry.code))
      .reduce((sum, entry) => sum + toScaledInteger(entry.balance), 0n);
  }

  _isCashAccount(code) {
    return CASH_ACCOUNT_PREFIXES.some((prefix) => code.startsWith(prefix));
  }

  _isInvestingAccount(code) {
    return code.startsWith('12') && code !== '1290';
  }

  _isFinancingAccount(code) {
    if (code.startsWith('22')) {
      return true;
    }

    return ['3100', '3400'].includes(code);
  }

  _getFinancingCashImpact(code, delta) {
    if (code === '3400') {
      return -delta;
    }

    return delta;
  }

  _resolveInvoiceRemainingScaledAmount(invoice) {
    if (typeof invoice.remainingAmount === 'number') {
      return toScaledInteger(invoice.remainingAmount.toString());
    }

    const totalAmount = toScaledInteger(invoice.total?.toString?.() ?? invoice.total ?? '0');
    if (invoice.status === 'paid') {
      return 0n;
    }

    const paidAmount = typeof invoice.paidAmount === 'number'
      ? toScaledInteger(invoice.paidAmount.toString())
      : 0n;
    const remainingAmount = totalAmount - paidAmount;

    return remainingAmount > 0n ? remainingAmount : 0n;
  }

  _resolveBillRemainingScaledAmount(bill) {
    const remainingAmount = resolveBillRemainingAmount(bill);
    return remainingAmount > 0 ? toScaledInteger(remainingAmount.toString()) : 0n;
  }

  _getDaysPastDue(asOfDate, referenceDateValue) {
    if (!referenceDateValue) {
      return 0;
    }

    const referenceDate = new Date(referenceDateValue);
    const asOfUtcMidnight = Date.UTC(
      asOfDate.getUTCFullYear(),
      asOfDate.getUTCMonth(),
      asOfDate.getUTCDate()
    );
    const referenceUtcMidnight = Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate()
    );

    return Math.floor((asOfUtcMidnight - referenceUtcMidnight) / 86400000);
  }

  _getARAgingBucketKey(daysPastDue) {
    const normalizedDays = Math.max(0, daysPastDue);

    if (normalizedDays <= 30) return 'days0_30';
    if (normalizedDays <= 60) return 'days31_60';
    if (normalizedDays <= 90) return 'days61_90';
    return 'days90Plus';
  }
}

module.exports = new ReportService();
