'use strict';

const reportService = require('./report.service');
const { success } = require('../../common/utils/response');
const { sendTabularExport } = require('../../common/utils/tabularExport');

function sendExport(res, { format, filenameBase, title, rows, fields }) {
  return sendTabularExport(res, {
    format,
    filenameBase,
    title,
    worksheetName: title,
    rows,
    fields,
  });
}

function toTrialBalanceRows(report) {
  const rows = report.accounts.map((entry) => ({
    section: 'Trial Balance',
    code: entry.code,
    nameEn: entry.nameEn,
    type: entry.type,
    nature: entry.nature,
    totalDebit: entry.totalDebit,
    totalCredit: entry.totalCredit,
    balance: entry.balance,
    comparisonBalance: entry.comparisonBalance || '',
    deltaBalance: entry.deltaBalance || '',
  }));

  rows.push({
    section: 'Totals',
    code: '',
    nameEn: 'Totals',
    type: '',
    nature: '',
    totalDebit: report.totals.totalDebits,
    totalCredit: report.totals.totalCredits,
    balance: report.totals.difference,
    comparisonBalance: report.comparison?.totals?.difference || '',
    deltaBalance: report.comparison?.delta?.difference || '',
  });

  return rows;
}

function toSectionRows(report, sectionKeys, sectionLabels, amountField = 'balance') {
  const comparisonField = amountField === 'amount' ? 'comparisonAmount' : 'comparisonBalance';
  const deltaField = amountField === 'amount' ? 'deltaAmount' : 'deltaBalance';
  const rows = [];

  for (const sectionKey of sectionKeys) {
    const sectionEntries = report[sectionKey] || [];
    for (const entry of sectionEntries) {
      rows.push({
        section: sectionLabels[sectionKey],
        code: entry.code,
        nameEn: entry.nameEn,
        [amountField]: entry[amountField],
        [comparisonField]: entry[comparisonField] || '',
        [deltaField]: entry[deltaField] || '',
      });
    }
  }

  rows.push(...buildTotalsRows(report, amountField, comparisonField, deltaField));
  return rows;
}

function buildTotalsRows(report, amountField, comparisonField, deltaField) {
  if (amountField === 'amount') {
    return [
      {
        section: 'Totals',
        code: '',
        nameEn: 'Operating cash flow',
        amount: report.totals.operatingCashFlow,
        comparisonAmount: report.comparison?.totals?.operatingCashFlow || '',
        deltaAmount: report.comparison?.delta?.operatingCashFlow || '',
      },
      {
        section: 'Totals',
        code: '',
        nameEn: 'Investing cash flow',
        amount: report.totals.investingCashFlow,
        comparisonAmount: report.comparison?.totals?.investingCashFlow || '',
        deltaAmount: report.comparison?.delta?.investingCashFlow || '',
      },
      {
        section: 'Totals',
        code: '',
        nameEn: 'Financing cash flow',
        amount: report.totals.financingCashFlow,
        comparisonAmount: report.comparison?.totals?.financingCashFlow || '',
        deltaAmount: report.comparison?.delta?.financingCashFlow || '',
      },
      {
        section: 'Totals',
        code: '',
        nameEn: 'Net increase in cash',
        amount: report.totals.netIncreaseInCash,
        comparisonAmount: report.comparison?.totals?.netIncreaseInCash || '',
        deltaAmount: report.comparison?.delta?.netIncreaseInCash || '',
      },
    ];
  }

  if (report.totals.totalAssets) {
    return [
      {
        section: 'Totals',
        code: '',
        nameEn: 'Total assets',
        balance: report.totals.totalAssets,
        [comparisonField]: report.comparison?.totals?.totalAssets || '',
        [deltaField]: report.comparison?.delta?.totalAssets || '',
      },
      {
        section: 'Totals',
        code: '',
        nameEn: 'Total liabilities',
        balance: report.totals.totalLiabilities,
        [comparisonField]: report.comparison?.totals?.totalLiabilities || '',
        [deltaField]: report.comparison?.delta?.totalLiabilities || '',
      },
      {
        section: 'Totals',
        code: '',
        nameEn: 'Total equity',
        balance: report.totals.totalEquity,
        [comparisonField]: report.comparison?.totals?.totalEquity || '',
        [deltaField]: report.comparison?.delta?.totalEquity || '',
      },
    ];
  }

  return [
    {
      section: 'Totals',
      code: '',
      nameEn: 'Net income',
      balance: report.totals.netIncome,
      [comparisonField]: report.comparison?.totals?.netIncome || '',
      [deltaField]: report.comparison?.delta?.netIncome || '',
    },
  ];
}

class ReportController {
  async trialBalance(req, res) {
    const report = await reportService.getTrialBalance(req.user.tenantId, req.query);
    return success(res, report);
  }

  async incomeStatement(req, res) {
    const report = await reportService.getIncomeStatement(req.user.tenantId, req.query);
    return success(res, report);
  }

  async balanceSheet(req, res) {
    const report = await reportService.getBalanceSheet(req.user.tenantId, req.query);
    return success(res, report);
  }

  async cashFlow(req, res) {
    const report = await reportService.getCashFlowStatement(req.user.tenantId, req.query);
    return success(res, report);
  }

  async exportTrialBalance(req, res) {
    const report = await reportService.getTrialBalance(req.user.tenantId, req.query);
    return sendExport(res, {
      format: req.query.format,
      filenameBase: 'trial-balance',
      title: 'Trial Balance',
      rows: toTrialBalanceRows(report),
      fields: [
        'section',
        'code',
        'nameEn',
        'type',
        'nature',
        'totalDebit',
        'totalCredit',
        'balance',
        'comparisonBalance',
        'deltaBalance',
      ],
    });
  }

  async exportIncomeStatement(req, res) {
    const report = await reportService.getIncomeStatement(req.user.tenantId, req.query);
    return sendExport(res, {
      format: req.query.format,
      filenameBase: 'income-statement',
      title: 'Income Statement',
      rows: toSectionRows(report, ['revenue', 'expenses'], {
        revenue: 'Revenue',
        expenses: 'Expenses',
      }),
      fields: [
        'section',
        'code',
        'nameEn',
        'balance',
        'comparisonBalance',
        'deltaBalance',
      ],
    });
  }

  async exportBalanceSheet(req, res) {
    const report = await reportService.getBalanceSheet(req.user.tenantId, req.query);
    return sendExport(res, {
      format: req.query.format,
      filenameBase: 'balance-sheet',
      title: 'Balance Sheet',
      rows: toSectionRows(report, ['assets', 'liabilities', 'equity'], {
        assets: 'Assets',
        liabilities: 'Liabilities',
        equity: 'Equity',
      }),
      fields: [
        'section',
        'code',
        'nameEn',
        'balance',
        'comparisonBalance',
        'deltaBalance',
      ],
    });
  }

  async exportCashFlow(req, res) {
    const report = await reportService.getCashFlowStatement(req.user.tenantId, req.query);
    return sendExport(res, {
      format: req.query.format,
      filenameBase: 'cash-flow-statement',
      title: 'Cash Flow Statement',
      rows: toSectionRows(report, ['operating', 'investing', 'financing', 'reconcilingItems'], {
        operating: 'Operating',
        investing: 'Investing',
        financing: 'Financing',
        reconcilingItems: 'Reconciling Items',
      }, 'amount'),
      fields: [
        'section',
        'code',
        'nameEn',
        'amount',
        'comparisonAmount',
        'deltaAmount',
      ],
    });
  }

}

module.exports = new ReportController();
