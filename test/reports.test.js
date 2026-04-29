'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reportService = require('../src/modules/report/report.service');
const accountService = require('../src/modules/account/account.service');
const taxService = require('../src/modules/tax/tax.service');
const fiscalPeriodService = require('../src/modules/fiscal-period/fiscalPeriod.service');
const customerService = require('../src/modules/customer/customer.service');
const supplierService = require('../src/modules/supplier/supplier.service');
const invoiceService = require('../src/modules/invoice/invoice.service');
const billService = require('../src/modules/bill/bill.service');
const { Invoice } = require('../src/modules/invoice/invoice.model');
const { Bill } = require('../src/modules/bill/bill.model');
const {
  ensureDatabase,
  closeDatabase,
  cleanupTenantData,
  createTenantFixture,
  createPostedEntry,
  createServer,
  closeServer,
  fetchJson,
  getAccountsByCode,
} = require('./helpers/integration');

const tenantIds = new Set();
let serverContext;

test.before(async () => {
  await ensureDatabase();
  serverContext = await createServer();
});

test.after(async () => {
  await closeServer(serverContext?.server);
  await cleanupTenantData(tenantIds);
  await closeDatabase();
});

async function createInputVatAccount(fixture) {
  return accountService.createAccount(
    fixture.tenant._id,
    {
      code: '1150',
      nameAr: 'Input VAT',
      nameEn: 'Input VAT',
      type: 'asset',
    },
    {
      userId: fixture.user._id,
      auditContext: fixture.auditContext,
    }
  );
}

async function createReportTaxedInvoice(fixture, accounts, taxRate, {
  amount,
  issueDate,
  dueDate = '2026-04-30',
  customerName = 'VAT Customer',
  finalStatus = 'sent',
  documentCurrency = 'SAR',
  exchangeRate,
}) {
  const invoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    {
      customerName,
      issueDate,
      dueDate,
      documentCurrency,
      exchangeRate,
      exchangeRateDate: exchangeRate ? issueDate : undefined,
      exchangeRateSource: exchangeRate ? 'manual' : undefined,
      lineItems: [{
        description: 'Taxed sale',
        quantity: '1',
        unitPrice: amount,
        taxRateId: taxRate._id.toString(),
        lineTotal: amount,
      }],
      subtotal: amount,
      total: amount,
      notes: '',
    },
    { auditContext: fixture.auditContext }
  );

  if (finalStatus === 'draft') {
    return invoice;
  }

  await invoiceService.markAsSent(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      arAccountId: accounts.get('1120')._id.toString(),
      revenueAccountId: accounts.get('4100')._id.toString(),
    },
    { auditContext: fixture.auditContext }
  );

  if (finalStatus === 'cancelled') {
    return invoiceService.cancelInvoice(
      invoice._id,
      fixture.tenant._id,
      fixture.user._id,
      { auditContext: fixture.auditContext }
    );
  }

  return invoiceService.getInvoiceById(invoice._id, fixture.tenant._id);
}

async function createReportTaxedBill(fixture, accounts, taxRate, {
  amount,
  issueDate,
  dueDate = '2026-04-30',
  supplierName = 'VAT Supplier',
  finalStatus = 'posted',
  documentCurrency = 'SAR',
  exchangeRate,
}) {
  const bill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    {
      supplierName,
      issueDate,
      dueDate,
      documentCurrency,
      exchangeRate,
      exchangeRateDate: exchangeRate ? issueDate : undefined,
      exchangeRateSource: exchangeRate ? 'manual' : undefined,
      lineItems: [{
        description: 'Taxed purchase',
        quantity: '1',
        unitPrice: amount,
        taxRateId: taxRate._id.toString(),
        lineTotal: amount,
      }],
      subtotal: amount,
      total: amount,
      notes: '',
    },
    { auditContext: fixture.auditContext }
  );

  if (finalStatus === 'draft') {
    return bill;
  }

  await billService.postBill(
    bill._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      apAccountId: accounts.get('2110')._id.toString(),
      debitAccountId: accounts.get('5200')._id.toString(),
    },
    { auditContext: fixture.auditContext }
  );

  if (finalStatus === 'cancelled') {
    return billService.cancelBill(
      bill._id,
      fixture.tenant._id,
      fixture.user._id,
      { auditContext: fixture.auditContext }
    );
  }

  return billService.getBillById(bill._id, fixture.tenant._id);
}

test('report routes return validation 4xx responses for missing required params', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/reports/income-statement`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  assert.equal(response.status, 422);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('vat return report aggregates tenant-scoped output and input VAT', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  const otherFixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);
  tenantIds.add(otherFixture.tenant._id);

  await createInputVatAccount(fixture);
  await createInputVatAccount(otherFixture);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1120', '4100', '2110', '5200']);
  const otherAccounts = await getAccountsByCode(otherFixture.tenant._id, ['1120', '4100', '2110', '5200']);
  const taxRate = await taxService.createTaxRate(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'VAT 15%', code: 'VAT15RPT', rate: '15', type: 'both' }
  );
  const reducedTaxRate = await taxService.createTaxRate(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'VAT 5%', code: 'VAT5RPT', rate: '5', type: 'both' }
  );
  const otherTaxRate = await taxService.createTaxRate(
    otherFixture.tenant._id,
    otherFixture.user._id,
    { name: 'VAT 15%', code: 'VAT15RPT', rate: '15', type: 'both' }
  );

  async function createTaxedInvoice(targetFixture, targetAccounts, targetTaxRate, {
    amount,
    issueDate,
    dueDate = '2026-04-30',
    customerName = 'VAT Customer',
    finalStatus = 'sent',
  }) {
    const invoice = await invoiceService.createInvoice(
      targetFixture.tenant._id,
      targetFixture.user._id,
      {
        customerName,
        issueDate,
        dueDate,
        currency: 'SAR',
        lineItems: [{
          description: 'Taxed sale',
          quantity: '1',
          unitPrice: amount,
          taxRateId: targetTaxRate._id.toString(),
          lineTotal: amount,
        }],
        subtotal: amount,
        total: amount,
        notes: '',
      },
      { auditContext: targetFixture.auditContext }
    );

    if (finalStatus === 'draft') {
      return invoice;
    }

    await invoiceService.markAsSent(
      invoice._id,
      targetFixture.tenant._id,
      targetFixture.user._id,
      {
        arAccountId: targetAccounts.get('1120')._id.toString(),
        revenueAccountId: targetAccounts.get('4100')._id.toString(),
      },
      { auditContext: targetFixture.auditContext }
    );

    if (finalStatus === 'cancelled') {
      return invoiceService.cancelInvoice(
        invoice._id,
        targetFixture.tenant._id,
        targetFixture.user._id,
        { auditContext: targetFixture.auditContext }
      );
    }

    return invoiceService.getInvoiceById(invoice._id, targetFixture.tenant._id);
  }

  async function createTaxedBill(targetFixture, targetAccounts, targetTaxRate, {
    amount,
    issueDate,
    dueDate = '2026-04-30',
    supplierName = 'VAT Supplier',
    finalStatus = 'posted',
  }) {
    const bill = await billService.createBill(
      targetFixture.tenant._id,
      targetFixture.user._id,
      {
        supplierName,
        issueDate,
        dueDate,
        currency: 'SAR',
        lineItems: [{
          description: 'Taxed purchase',
          quantity: '1',
          unitPrice: amount,
          taxRateId: targetTaxRate._id.toString(),
          lineTotal: amount,
        }],
        subtotal: amount,
        total: amount,
        notes: '',
      },
      { auditContext: targetFixture.auditContext }
    );

    if (finalStatus === 'draft') {
      return bill;
    }

    await billService.postBill(
      bill._id,
      targetFixture.tenant._id,
      targetFixture.user._id,
      {
        apAccountId: targetAccounts.get('2110')._id.toString(),
        debitAccountId: targetAccounts.get('5200')._id.toString(),
      },
      { auditContext: targetFixture.auditContext }
    );

    if (finalStatus === 'cancelled') {
      return billService.cancelBill(
        bill._id,
        targetFixture.tenant._id,
        targetFixture.user._id,
        { auditContext: targetFixture.auditContext }
      );
    }

    return billService.getBillById(bill._id, targetFixture.tenant._id);
  }

  const includedInvoice = await createTaxedInvoice(fixture, accounts, taxRate, {
    amount: '100',
    issueDate: '2026-04-10',
    customerName: 'Included Customer',
  });
  await createTaxedInvoice(fixture, accounts, reducedTaxRate, {
    amount: '20',
    issueDate: '2026-04-18',
    customerName: 'Reduced Customer',
  });
  await createTaxedInvoice(fixture, accounts, taxRate, {
    amount: '50',
    issueDate: '2026-04-11',
    finalStatus: 'draft',
  });
  await createTaxedInvoice(fixture, accounts, taxRate, {
    amount: '80',
    issueDate: '2026-04-12',
    finalStatus: 'cancelled',
  });
  await createTaxedInvoice(fixture, accounts, taxRate, {
    amount: '200',
    issueDate: '2026-05-01',
  });
  const softDeletedInvoice = await createTaxedInvoice(fixture, accounts, taxRate, {
    amount: '300',
    issueDate: '2026-04-20',
  });
  await Invoice.updateOne(
    { _id: softDeletedInvoice._id, tenantId: fixture.tenant._id },
    { $set: { deletedAt: new Date() } }
  );
  await createTaxedInvoice(otherFixture, otherAccounts, otherTaxRate, {
    amount: '999',
    issueDate: '2026-04-10',
  });

  const noTaxInvoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    {
      customerName: 'No Tax Customer',
      issueDate: '2026-04-13',
      dueDate: '2026-04-30',
      currency: 'SAR',
      lineItems: [{
        description: 'No tax sale',
        quantity: '1',
        unitPrice: '25',
        lineTotal: '25',
      }],
      subtotal: '25',
      total: '25',
      notes: '',
    },
    { auditContext: fixture.auditContext }
  );
  await invoiceService.markAsSent(
    noTaxInvoice._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      arAccountId: accounts.get('1120')._id.toString(),
      revenueAccountId: accounts.get('4100')._id.toString(),
    },
    { auditContext: fixture.auditContext }
  );

  const includedBill = await createTaxedBill(fixture, accounts, taxRate, {
    amount: '40',
    issueDate: '2026-04-14',
    supplierName: 'Included Supplier',
  });
  await createTaxedBill(fixture, accounts, reducedTaxRate, {
    amount: '20',
    issueDate: '2026-04-19',
    supplierName: 'Reduced Supplier',
  });
  await createTaxedBill(fixture, accounts, taxRate, {
    amount: '20',
    issueDate: '2026-04-15',
    finalStatus: 'draft',
  });
  await createTaxedBill(fixture, accounts, taxRate, {
    amount: '70',
    issueDate: '2026-04-16',
    finalStatus: 'cancelled',
  });
  await createTaxedBill(fixture, accounts, taxRate, {
    amount: '60',
    issueDate: '2026-03-31',
  });
  const softDeletedBill = await createTaxedBill(fixture, accounts, taxRate, {
    amount: '300',
    issueDate: '2026-04-20',
  });
  await Bill.updateOne(
    { _id: softDeletedBill._id, tenantId: fixture.tenant._id },
    { $set: { deletedAt: new Date() } }
  );
  await createTaxedBill(otherFixture, otherAccounts, otherTaxRate, {
    amount: '888',
    issueDate: '2026-04-14',
  });

  const noTaxBill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    {
      supplierName: 'No Tax Supplier',
      issueDate: '2026-04-17',
      dueDate: '2026-04-30',
      currency: 'SAR',
      lineItems: [{
        description: 'No tax purchase',
        quantity: '1',
        unitPrice: '30',
        lineTotal: '30',
      }],
      subtotal: '30',
      total: '30',
      notes: '',
    },
    { auditContext: fixture.auditContext }
  );
  await billService.postBill(
    noTaxBill._id,
    fixture.tenant._id,
    fixture.user._id,
    {
      apAccountId: accounts.get('2110')._id.toString(),
      debitAccountId: accounts.get('5200')._id.toString(),
    },
    { auditContext: fixture.auditContext }
  );

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/reports/vat-return?startDate=2026-04-01&endDate=2026-04-30&includeDetails=true`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data.summary, {
    outputVAT: '16',
    inputVAT: '7',
    netVAT: '9',
    status: 'payable',
  });
  assert.equal(body.data.basis, 'accrual');
  assert.equal(body.data.currency, 'SAR');
  assert.equal(body.data.amountsIn, 'baseCurrency');
  assert.match(body.data.period.startDate, /^2026-04-01T00:00:00\.000Z$/);
  assert.match(body.data.period.endDate, /^2026-04-30T23:59:59\.999Z$/);
  assert.deepEqual(body.data.outputVat, {
    taxableAmount: '120',
    taxAmount: '16',
    byRate: [
      {
        taxRateId: taxRate._id.toString(),
        taxRateName: 'VAT 15%',
        taxRate: '15',
        taxableAmount: '100',
        taxAmount: '15',
        documentsCount: 1,
      },
      {
        taxRateId: reducedTaxRate._id.toString(),
        taxRateName: 'VAT 5%',
        taxRate: '5',
        taxableAmount: '20',
        taxAmount: '1',
        documentsCount: 1,
      },
    ],
  });
  assert.deepEqual(body.data.inputVat, {
    taxableAmount: '60',
    taxAmount: '7',
    byRate: [
      {
        taxRateId: taxRate._id.toString(),
        taxRateName: 'VAT 15%',
        taxRate: '15',
        taxableAmount: '40',
        taxAmount: '6',
        documentsCount: 1,
      },
      {
        taxRateId: reducedTaxRate._id.toString(),
        taxRateName: 'VAT 5%',
        taxRate: '5',
        taxableAmount: '20',
        taxAmount: '1',
        documentsCount: 1,
      },
    ],
  });
  assert.deepEqual(body.data.netVat, {
    amount: '9',
    status: 'payable',
  });
  assert.deepEqual(body.data.documents, {
    salesInvoicesCount: 2,
    purchaseBillsCount: 2,
  });
  assert.equal(body.data.breakdown.length, 2);
  const standardBreakdown = body.data.breakdown.find((row) => row.taxRateId === taxRate._id.toString());
  assert.deepEqual(standardBreakdown, {
    taxRateId: taxRate._id.toString(),
    taxRateName: 'VAT 15%',
    taxRate: '15',
    outputTaxableAmount: '100',
    inputTaxableAmount: '40',
    taxableAmount: '60',
    outputVAT: '15',
    inputVAT: '6',
    netVAT: '9',
    outputDocumentsCount: 1,
    inputDocumentsCount: 1,
  });
  assert.equal(body.data.details.sales.length, 2);
  assert.equal(body.data.details.sales[0].invoiceId, includedInvoice._id.toString());
  assert.equal(body.data.details.sales[0].documentType, 'salesInvoice');
  assert.equal(body.data.details.sales[0].documentId, includedInvoice._id.toString());
  assert.equal(body.data.details.sales[0].invoiceNumber, includedInvoice.invoiceNumber);
  assert.equal(body.data.details.sales[0].documentNumber, includedInvoice.invoiceNumber);
  assert.match(body.data.details.sales[0].issueDate, /^2026-04-10T00:00:00\.000Z$/);
  assert.equal(body.data.details.sales[0].customerName, 'Included Customer');
  assert.equal(body.data.details.sales[0].taxableAmount, '100');
  assert.equal(body.data.details.sales[0].taxAmount, '15');
  assert.equal(body.data.details.sales[0].total, '115');
  assert.equal(body.data.details.sales[0].documentCurrency, 'SAR');
  assert.equal(body.data.details.sales[0].baseCurrency, 'SAR');
  assert.equal(body.data.details.sales[0].lines[0].taxRateId, taxRate._id.toString());
  assert.equal(body.data.details.sales[0].lines[0].taxableAmount, '100');
  assert.equal(body.data.details.sales[0].lines[0].taxAmount, '15');
  assert.equal(body.data.details.purchases.length, 2);
  assert.equal(body.data.details.purchases[0].billId, includedBill._id.toString());
  assert.equal(body.data.details.purchases[0].documentType, 'purchaseBill');
  assert.equal(body.data.details.purchases[0].documentId, includedBill._id.toString());
  assert.equal(body.data.details.purchases[0].billNumber, includedBill.billNumber);
  assert.equal(body.data.details.purchases[0].documentNumber, includedBill.billNumber);
  assert.match(body.data.details.purchases[0].issueDate, /^2026-04-14T00:00:00\.000Z$/);
  assert.equal(body.data.details.purchases[0].supplierName, 'Included Supplier');
  assert.equal(body.data.details.purchases[0].taxableAmount, '40');
  assert.equal(body.data.details.purchases[0].taxAmount, '6');
  assert.equal(body.data.details.purchases[0].total, '46');
  assert.equal(body.data.details.purchases[0].documentCurrency, 'SAR');
  assert.equal(body.data.details.purchases[0].baseCurrency, 'SAR');
  assert.equal(body.data.details.purchases[0].lines[0].taxRateId, taxRate._id.toString());
  assert.equal(body.data.details.purchases[0].lines[0].taxableAmount, '40');
  assert.equal(body.data.details.purchases[0].lines[0].taxAmount, '6');

  const filteredReport = await reportService.getVatReturn(fixture.tenant._id, {
    startDate: '2026-04-01',
    endDate: '2026-04-30',
    taxRateId: taxRate._id.toString(),
    refresh: true,
  });
  assert.equal(filteredReport.summary.netVAT, '9');
  assert.equal(filteredReport.outputVat.taxableAmount, '100');
  assert.equal(filteredReport.outputVat.taxAmount, '15');
  assert.equal(filteredReport.inputVat.taxableAmount, '40');
  assert.equal(filteredReport.inputVat.taxAmount, '6');
  assert.equal(filteredReport.breakdown.length, 1);
  assert.equal(filteredReport.breakdown[0].taxRateId, taxRate._id.toString());

  const noDetailsResult = await fetchJson(
    `${serverContext.baseUrl}/api/v1/reports/vat-return?startDate=2026-04-01&endDate=2026-04-30`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );
  assert.equal(noDetailsResult.response.status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(noDetailsResult.body.data, 'details'), false);
});

test('vat return reports refundable and zero statuses with explicit zero-rated taxable lines', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  await createInputVatAccount(fixture);
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1120', '4100', '2110', '5200']);
  const purchaseTaxRate = await taxService.createTaxRate(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Purchase VAT 15%', code: 'PURCHVAT15RPT', rate: '15', type: 'purchase' }
  );
  const zeroTaxRate = await taxService.createTaxRate(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Zero VAT', code: 'ZEROVATRPT', rate: '0', type: 'sales' }
  );

  await createReportTaxedBill(fixture, accounts, purchaseTaxRate, {
    amount: '100',
    issueDate: '2026-04-05',
  });
  await createReportTaxedInvoice(fixture, accounts, zeroTaxRate, {
    amount: '200',
    issueDate: '2026-05-05',
  });

  const refundableReport = await reportService.getVatReturn(fixture.tenant._id, {
    startDate: '2026-04-01',
    endDate: '2026-04-30',
    refresh: true,
  });
  assert.deepEqual(refundableReport.summary, {
    outputVAT: '0',
    inputVAT: '15',
    netVAT: '-15',
    status: 'refundable',
  });
  assert.deepEqual(refundableReport.netVat, {
    amount: '-15',
    status: 'refundable',
  });
  assert.equal(refundableReport.documents.salesInvoicesCount, 0);
  assert.equal(refundableReport.documents.purchaseBillsCount, 1);

  const zeroReport = await reportService.getVatReturn(fixture.tenant._id, {
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    includeDetails: true,
    refresh: true,
  });
  assert.deepEqual(zeroReport.summary, {
    outputVAT: '0',
    inputVAT: '0',
    netVAT: '0',
    status: 'zero',
  });
  assert.equal(zeroReport.outputVat.taxableAmount, '200');
  assert.equal(zeroReport.outputVat.taxAmount, '0');
  assert.deepEqual(zeroReport.outputVat.byRate, [{
    taxRateId: zeroTaxRate._id.toString(),
    taxRateName: 'Zero VAT',
    taxRate: '0',
    taxableAmount: '200',
    taxAmount: '0',
    documentsCount: 1,
  }]);
  assert.equal(zeroReport.documents.salesInvoicesCount, 1);
  assert.equal(zeroReport.details.sales[0].taxableAmount, '200');
  assert.equal(zeroReport.details.sales[0].taxAmount, '0');
  assert.equal(zeroReport.details.sales[0].lines[0].taxRateId, zeroTaxRate._id.toString());
});

test('vat return uses base-currency taxable and VAT amounts for foreign documents', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  await createInputVatAccount(fixture);
  const accounts = await getAccountsByCode(fixture.tenant._id, ['1120', '4100', '2110', '5200']);
  const taxRate = await taxService.createTaxRate(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Foreign VAT 15%', code: 'FXVAT15RPT', rate: '15', type: 'both' }
  );

  const invoice = await createReportTaxedInvoice(fixture, accounts, taxRate, {
    amount: '100',
    issueDate: '2026-04-10',
    customerName: 'Foreign Customer',
    documentCurrency: 'USD',
    exchangeRate: '3.75',
  });
  const bill = await createReportTaxedBill(fixture, accounts, taxRate, {
    amount: '100',
    issueDate: '2026-04-11',
    supplierName: 'Foreign Supplier',
    documentCurrency: 'USD',
    exchangeRate: '3.75',
  });

  const report = await reportService.getVatReturn(fixture.tenant._id, {
    startDate: '2026-04-01',
    endDate: '2026-04-30',
    includeDetails: true,
    refresh: true,
  });

  assert.equal(report.currency, 'SAR');
  assert.equal(report.amountsIn, 'baseCurrency');
  assert.deepEqual(report.summary, {
    outputVAT: '56.25',
    inputVAT: '56.25',
    netVAT: '0',
    status: 'zero',
  });
  assert.equal(report.outputVat.taxableAmount, '375');
  assert.equal(report.outputVat.taxAmount, '56.25');
  assert.equal(report.inputVat.taxableAmount, '375');
  assert.equal(report.inputVat.taxAmount, '56.25');
  assert.equal(report.outputVat.byRate[0].taxableAmount, '375');
  assert.equal(report.outputVat.byRate[0].taxAmount, '56.25');
  assert.equal(report.inputVat.byRate[0].taxableAmount, '375');
  assert.equal(report.inputVat.byRate[0].taxAmount, '56.25');
  assert.equal(report.details.sales[0].invoiceId, invoice._id.toString());
  assert.equal(report.details.sales[0].documentCurrency, 'USD');
  assert.equal(report.details.sales[0].baseCurrency, 'SAR');
  assert.equal(report.details.sales[0].taxableAmount, '375');
  assert.equal(report.details.sales[0].taxAmount, '56.25');
  assert.equal(report.details.purchases[0].billId, bill._id.toString());
  assert.equal(report.details.purchases[0].documentCurrency, 'USD');
  assert.equal(report.details.purchases[0].baseCurrency, 'SAR');
  assert.equal(report.details.purchases[0].taxableAmount, '375');
  assert.equal(report.details.purchases[0].taxAmount, '56.25');
});

test('vat return endpoint validates required dates, date order, taxRateId, and basis', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const headers = {
    Authorization: `Bearer ${fixture.accessToken}`,
  };
  const invalidRequests = [
    '/api/v1/reports/vat-return',
    '/api/v1/reports/vat-return?startDate=not-a-date&endDate=2026-04-30',
    '/api/v1/reports/vat-return?startDate=2026-05-01&endDate=2026-04-30',
    '/api/v1/reports/vat-return?startDate=2026-04-01&endDate=2026-04-30&taxRateId=bad-id',
    '/api/v1/reports/vat-return?startDate=2026-04-01&endDate=2026-04-30&basis=cash',
  ];

  for (const path of invalidRequests) {
    const { response, body } = await fetchJson(`${serverContext.baseUrl}${path}`, { headers });
    assert.equal(response.status, 422, path);
    assert.equal(body.success, false, path);
    assert.equal(body.error.code, 'VALIDATION_ERROR', path);
  }
});

test('balance sheet current-year earnings are limited to the fiscal year containing the as-of date', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2025 });
  tenantIds.add(fixture.tenant._id);

  await fiscalPeriodService.createFiscalYear(
    fixture.tenant._id,
    { year: 2026 },
    {
      userId: fixture.user._id,
      auditContext: fixture.auditContext,
    }
  );

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '4100']);

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2025, 2, 10)).toISOString(),
      description: 'Prior year revenue',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '1000.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '1000.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2026, 4, 10)).toISOString(),
      description: 'Current year revenue',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '300.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '300.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  const report = await reportService.getBalanceSheet(fixture.tenant._id, {
    asOfDate: new Date(Date.UTC(2026, 5, 30)).toISOString(),
  });

  const currentYearEarnings = report.equity.find((entry) => entry.code === '3300');

  assert.equal(currentYearEarnings?.balance, '300');
  assert.deepEqual(report.yearClose.pendingPriorYearClosures, [2025]);
});

test('cash flow reports support comparison and export formats', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '4100', '5200']);

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2026, 0, 10)).toISOString(),
      description: 'Comparison period revenue',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '100.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '100.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2026, 1, 10)).toISOString(),
      description: 'Primary period revenue',
      lines: [
        { accountId: accounts.get('1111')._id.toString(), debit: '500.00', credit: '0' },
        { accountId: accounts.get('4100')._id.toString(), debit: '0', credit: '500.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  await createPostedEntry(
    fixture.tenant._id,
    fixture.user._id,
    {
      date: new Date(Date.UTC(2026, 1, 15)).toISOString(),
      description: 'Primary period salary',
      lines: [
        { accountId: accounts.get('5200')._id.toString(), debit: '200.00', credit: '0' },
        { accountId: accounts.get('1111')._id.toString(), debit: '0', credit: '200.00' },
      ],
    },
    { auditContext: fixture.auditContext }
  );

  const report = await reportService.getCashFlowStatement(fixture.tenant._id, {
    startDate: new Date(Date.UTC(2026, 1, 1)).toISOString(),
    endDate: new Date(Date.UTC(2026, 1, 28)).toISOString(),
    compareStartDate: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    compareEndDate: new Date(Date.UTC(2026, 0, 31)).toISOString(),
  });

  assert.equal(report.totals.netIncreaseInCash, '300');
  assert.equal(report.comparison?.totals?.netIncreaseInCash, '100');
  assert.equal(report.comparison?.delta?.netIncreaseInCash, '200');

  const excelResponse = await fetch(`${serverContext.baseUrl}/api/v1/reports/cash-flow/export?startDate=2026-02-01&endDate=2026-02-28&format=excel`, {
    headers: {
      Authorization: `Bearer ${fixture.accessToken}`,
    },
  });
  assert.equal(excelResponse.status, 200);
  assert.match(excelResponse.headers.get('content-type') || '', /application\/vnd\.ms-excel/i);

  const pdfResponse = await fetch(`${serverContext.baseUrl}/api/v1/reports/cash-flow/export?startDate=2026-02-01&endDate=2026-02-28&format=pdf`, {
    headers: {
      Authorization: `Bearer ${fixture.accessToken}`,
    },
  });
  assert.equal(pdfResponse.status, 200);
  assert.match(pdfResponse.headers.get('content-type') || '', /application\/pdf/i);
});

test('invoice reads derive overdue status and stay in sync with due-date and payment changes', async () => {
  const today = new Date();
  const fiscalYear = today.getUTCFullYear();
  const issueDate = today.toISOString().slice(0, 10);

  const overdueDueDate = new Date(today);
  overdueDueDate.setUTCDate(overdueDueDate.getUTCDate() - 1);

  const futureDueDate = new Date(today);
  futureDueDate.setUTCDate(futureDueDate.getUTCDate() + 7);

  const fixture = await createTenantFixture({ fiscalYear });
  tenantIds.add(fixture.tenant._id);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100']);
  const cashAccountId = accounts.get('1111')._id.toString();
  const arAccountId = accounts.get('1120')._id.toString();
  const revenueAccountId = accounts.get('4100')._id.toString();

  const customer = await customerService.createCustomer(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Gamma Trading', email: 'gamma@example.com' },
    { auditContext: fixture.auditContext }
  );

  const invoice = await invoiceService.createInvoice(
    fixture.tenant._id,
    fixture.user._id,
    {
      customerId: customer._id.toString(),
      customerName: customer.name,
      customerEmail: customer.email,
      issueDate,
      dueDate: overdueDueDate.toISOString().slice(0, 10),
      currency: 'SAR',
      lineItems: [
        {
          description: 'Consulting fee',
          quantity: '1',
          unitPrice: '100.00',
          lineTotal: '100.00',
        },
      ],
      subtotal: '100.00',
      total: '100.00',
      notes: '',
    },
    { auditContext: fixture.auditContext }
  );

  await invoiceService.markAsSent(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    { arAccountId, revenueAccountId },
    { auditContext: fixture.auditContext }
  );

  await invoiceService.recordPayment(
    invoice._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '25.00', paymentDate: issueDate },
    { auditContext: fixture.auditContext }
  );

  const authHeaders = {
    Authorization: `Bearer ${fixture.accessToken}`,
  };

  const { response: overdueDetailResponse, body: overdueDetailBody } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/invoices/${invoice._id}`,
    {
      headers: authHeaders,
    }
  );

  assert.equal(overdueDetailResponse.status, 200);
  assert.equal(overdueDetailBody.data.invoice.status, 'overdue');
  assert.equal(overdueDetailBody.data.invoice.paidAmount, 25);
  assert.equal(overdueDetailBody.data.invoice.remainingAmount, 75);

  const { response: overdueListResponse, body: overdueListBody } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/invoices?status=overdue`,
    {
      headers: authHeaders,
    }
  );

  assert.equal(overdueListResponse.status, 200);
  assert.equal(overdueListBody.meta.pagination.total, 1);
  assert.equal(overdueListBody.data[0]._id, invoice._id.toString());
  assert.equal(overdueListBody.data[0].status, 'overdue');

  await Invoice.updateOne(
    { _id: invoice._id, tenantId: fixture.tenant._id },
    { $set: { dueDate: futureDueDate } }
  );

  const { body: currentDetailBody } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/invoices/${invoice._id}`,
    {
      headers: authHeaders,
    }
  );

  assert.equal(currentDetailBody.data.invoice.status, 'partially_paid');

  const { body: currentOverdueListBody } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/invoices?status=overdue`,
    {
      headers: authHeaders,
    }
  );

  assert.equal(currentOverdueListBody.meta.pagination.total, 0);

  const { body: partialListBody } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/invoices?status=partially_paid`,
    {
      headers: authHeaders,
    }
  );

  assert.equal(partialListBody.meta.pagination.total, 1);
  assert.equal(partialListBody.data[0]._id, invoice._id.toString());
  assert.equal(partialListBody.data[0].status, 'partially_paid');

  const { response: paidResponse, body: paidBody } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/invoices/${invoice._id}/pay`,
    {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cashAccountId,
        amount: '75.00',
        paymentDate: issueDate,
      }),
    }
  );

  assert.equal(paidResponse.status, 200);
  assert.equal(paidBody.data.invoice.status, 'paid');
  assert.equal(paidBody.data.invoice.remainingAmount, 0);

  const { body: paidDetailBody } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/invoices/${invoice._id}`,
    {
      headers: authHeaders,
    }
  );

  assert.equal(paidDetailBody.data.invoice.status, 'paid');
  assert.equal(paidDetailBody.data.invoice.remainingAmount, 0);
});

test('ar aging report groups outstanding balances by customer and aging bucket', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '1120', '4100']);
  const arAccountId = accounts.get('1120')._id.toString();
  const revenueAccountId = accounts.get('4100')._id.toString();
  const cashAccountId = accounts.get('1111')._id.toString();

  async function createSentInvoice(customer, { amount, issueDate, dueDate }) {
    const invoice = await invoiceService.createInvoice(
      fixture.tenant._id,
      fixture.user._id,
      {
        customerId: customer._id.toString(),
        customerName: customer.name,
        customerEmail: customer.email,
        issueDate,
        dueDate,
        currency: 'SAR',
        lineItems: [
          {
            description: 'Service line',
            quantity: '1',
            unitPrice: amount,
            lineTotal: amount,
          },
        ],
        subtotal: amount,
        total: amount,
        notes: '',
      },
      { auditContext: fixture.auditContext }
    );

    await invoiceService.markAsSent(
      invoice._id,
      fixture.tenant._id,
      fixture.user._id,
      { arAccountId, revenueAccountId },
      { auditContext: fixture.auditContext }
    );

    return invoiceService.getInvoiceById(invoice._id, fixture.tenant._id);
  }

  const customerA = await customerService.createCustomer(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Alpha Stores', email: 'alpha@example.com' },
    { auditContext: fixture.auditContext }
  );
  const customerB = await customerService.createCustomer(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Beta Supplies', email: 'beta@example.com' },
    { auditContext: fixture.auditContext }
  );

  const invoiceA1 = await createSentInvoice(customerA, {
    amount: '1000.00',
    issueDate: '2026-04-01',
    dueDate: '2026-04-10',
  });
  const invoiceA2 = await createSentInvoice(customerA, {
    amount: '500.00',
    issueDate: '2026-02-01',
    dueDate: '2026-02-15',
  });
  const invoiceB1 = await createSentInvoice(customerB, {
    amount: '400.00',
    issueDate: '2026-01-01',
    dueDate: '2026-01-15',
  });
  const invoiceB2 = await createSentInvoice(customerB, {
    amount: '200.00',
    issueDate: '2026-04-18',
    dueDate: '2026-04-30',
  });
  const invoiceExcluded = await createSentInvoice(customerB, {
    amount: '250.00',
    issueDate: '2026-03-01',
    dueDate: '2026-03-15',
  });

  await invoiceService.recordPayment(
    invoiceA2._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '200.00', paymentDate: '2026-03-01' },
    { auditContext: fixture.auditContext }
  );
  await invoiceService.recordPayment(
    invoiceExcluded._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '250.00', paymentDate: '2026-03-20' },
    { auditContext: fixture.auditContext }
  );

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/reports/ar-aging?asOfDate=2026-04-21`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.summary.totalOutstanding, '1900');
  assert.equal(body.data.summary.customersWithOutstanding, 2);
  assert.equal(body.data.summary.overdueInvoicesCount, 3);
  assert.match(body.data.asOfDate, /^2026-04-21T23:59:59\.999Z$/);

  const rowA = body.data.rows.find((row) => row.customerId === customerA._id.toString());
  const rowB = body.data.rows.find((row) => row.customerId === customerB._id.toString());

  assert.deepEqual(rowA, {
    customerId: customerA._id.toString(),
    customerName: 'Alpha Stores',
    days0_30: '1000',
    days31_60: '0',
    days61_90: '300',
    days90Plus: '0',
    totalOutstanding: '1300',
  });
  assert.deepEqual(rowB, {
    customerId: customerB._id.toString(),
    customerName: 'Beta Supplies',
    days0_30: '200',
    days31_60: '0',
    days61_90: '0',
    days90Plus: '400',
    totalOutstanding: '600',
  });

  const serviceReport = await reportService.getARAging(fixture.tenant._id, {
    asOfDate: '2026-04-21',
  });

  assert.equal(serviceReport.summary.totalOutstanding, '1900');
  assert.equal(serviceReport.rows.length, 2);

  assert.ok(invoiceA1);
  assert.ok(invoiceB1);
  assert.ok(invoiceB2);
});

test('supplier statement combines bills and payments into a payable running balance', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200']);
  const cashAccountId = accounts.get('1111')._id.toString();
  const apAccountId = accounts.get('2110')._id.toString();
  const debitAccountId = accounts.get('5200')._id.toString();

  const supplier = await supplierService.createSupplier(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Cairo Industrial', email: 'cairo@example.com' },
    { auditContext: fixture.auditContext }
  );

  async function createPostedBill({ amount, issueDate, dueDate }) {
    const bill = await billService.createBill(
      fixture.tenant._id,
      fixture.user._id,
      {
        supplierId: supplier._id.toString(),
        supplierName: supplier.name,
        supplierEmail: supplier.email,
        issueDate,
        dueDate,
        currency: 'SAR',
        lineItems: [
          {
            description: 'Expense line',
            quantity: '1',
            unitPrice: amount,
            lineTotal: amount,
          },
        ],
        subtotal: amount,
        total: amount,
        notes: '',
      },
      { auditContext: fixture.auditContext }
    );

    await billService.postBill(
      bill._id,
      fixture.tenant._id,
      fixture.user._id,
      { apAccountId, debitAccountId },
      { auditContext: fixture.auditContext }
    );

    return billService.getBillById(bill._id, fixture.tenant._id);
  }

  const bill1 = await createPostedBill({
    amount: '1000.00',
    issueDate: '2026-04-01',
    dueDate: '2026-04-10',
  });
  const bill2 = await createPostedBill({
    amount: '400.00',
    issueDate: '2026-04-15',
    dueDate: '2026-04-25',
  });

  await billService.recordPayment(
    bill1._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '250.00', paymentDate: '2026-04-05' },
    { auditContext: fixture.auditContext }
  );
  await billService.recordPayment(
    bill2._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '100.00', paymentDate: '2026-04-20' },
    { auditContext: fixture.auditContext }
  );

  const statement = await supplierService.getSupplierStatement(supplier._id, fixture.tenant._id);
  const paginatedStatement = await supplierService.getSupplierStatement(
    supplier._id,
    fixture.tenant._id,
    { page: 2, limit: 2 }
  );

  assert.equal(statement.summary.totalBilled, 1400);
  assert.equal(statement.summary.totalPaid, 350);
  assert.equal(statement.summary.outstandingBalance, 1050);
  assert.deepEqual(
    statement.transactions.map((transaction) => ({
      type: transaction.type,
      date: transaction.date.toISOString().slice(0, 10),
      reference: transaction.reference,
      debit: transaction.debit,
      credit: transaction.credit,
      runningBalance: transaction.runningBalance,
      billId: transaction.billId,
    })),
    [
      {
        type: 'bill',
        date: '2026-04-01',
        reference: bill1.billNumber,
        debit: 0,
        credit: 1000,
        runningBalance: 1000,
        billId: bill1._id.toString(),
      },
      {
        type: 'payment',
        date: '2026-04-05',
        reference: bill1.billNumber,
        debit: 250,
        credit: 0,
        runningBalance: 750,
        billId: bill1._id.toString(),
      },
      {
        type: 'bill',
        date: '2026-04-15',
        reference: bill2.billNumber,
        debit: 0,
        credit: 400,
        runningBalance: 1150,
        billId: bill2._id.toString(),
      },
      {
        type: 'payment',
        date: '2026-04-20',
        reference: bill2.billNumber,
        debit: 100,
        credit: 0,
        runningBalance: 1050,
        billId: bill2._id.toString(),
      },
    ]
  );
  assert.equal(paginatedStatement.pagination.page, 2);
  assert.equal(paginatedStatement.pagination.limit, 2);
  assert.equal(paginatedStatement.pagination.total, 4);
  assert.equal(paginatedStatement.transactions.length, 2);
  assert.equal(paginatedStatement.transactions[0].reference, bill2.billNumber);
  assert.equal(paginatedStatement.transactions[1].reference, bill2.billNumber);

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/suppliers/${supplier._id}/statement?page=2&limit=2`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.summary.totalBilled, 1400);
  assert.equal(body.data.summary.totalPaid, 350);
  assert.equal(body.data.summary.outstandingBalance, 1050);
  assert.equal(body.data.pagination.page, 2);
  assert.equal(body.data.pagination.limit, 2);
  assert.equal(body.data.pagination.total, 4);
  assert.equal(body.data.transactions.length, 2);
});

test('ap aging report groups outstanding balances by supplier and aging bucket', async () => {
  const fixture = await createTenantFixture({ fiscalYear: 2026 });
  tenantIds.add(fixture.tenant._id);

  const accounts = await getAccountsByCode(fixture.tenant._id, ['1111', '2110', '5200']);
  const cashAccountId = accounts.get('1111')._id.toString();
  const apAccountId = accounts.get('2110')._id.toString();
  const debitAccountId = accounts.get('5200')._id.toString();

  async function createPostedBill(supplier, { amount, issueDate, dueDate }) {
    const bill = await billService.createBill(
      fixture.tenant._id,
      fixture.user._id,
      {
        supplierId: supplier._id.toString(),
        supplierName: supplier.name,
        supplierEmail: supplier.email,
        issueDate,
        dueDate,
        currency: 'SAR',
        lineItems: [
          {
            description: 'Expense line',
            quantity: '1',
            unitPrice: amount,
            lineTotal: amount,
          },
        ],
        subtotal: amount,
        total: amount,
        notes: '',
      },
      { auditContext: fixture.auditContext }
    );

    await billService.postBill(
      bill._id,
      fixture.tenant._id,
      fixture.user._id,
      { apAccountId, debitAccountId },
      { auditContext: fixture.auditContext }
    );

    return billService.getBillById(bill._id, fixture.tenant._id);
  }

  const supplierA = await supplierService.createSupplier(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Alpha Supplies', email: 'alpha@example.com' },
    { auditContext: fixture.auditContext }
  );
  const supplierB = await supplierService.createSupplier(
    fixture.tenant._id,
    fixture.user._id,
    { name: 'Beta Manufacturing', email: 'beta@example.com' },
    { auditContext: fixture.auditContext }
  );

  const billA1 = await createPostedBill(supplierA, {
    amount: '1000.00',
    issueDate: '2026-04-01',
    dueDate: '2026-04-10',
  });
  const billA2 = await createPostedBill(supplierA, {
    amount: '500.00',
    issueDate: '2026-02-01',
    dueDate: '2026-02-15',
  });
  const billB1 = await createPostedBill(supplierB, {
    amount: '400.00',
    issueDate: '2026-01-01',
    dueDate: '2026-01-15',
  });
  const billB2 = await createPostedBill(supplierB, {
    amount: '200.00',
    issueDate: '2026-04-18',
    dueDate: '2026-04-30',
  });
  const billExcluded = await createPostedBill(supplierB, {
    amount: '250.00',
    issueDate: '2026-03-01',
    dueDate: '2026-03-15',
  });

  await billService.recordPayment(
    billA2._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '200.00', paymentDate: '2026-03-01' },
    { auditContext: fixture.auditContext }
  );
  await billService.recordPayment(
    billExcluded._id,
    fixture.tenant._id,
    fixture.user._id,
    { cashAccountId, amount: '250.00', paymentDate: '2026-03-20' },
    { auditContext: fixture.auditContext }
  );

  const draftBill = await billService.createBill(
    fixture.tenant._id,
    fixture.user._id,
    {
      supplierId: supplierA._id.toString(),
      supplierName: supplierA.name,
      supplierEmail: supplierA.email,
      issueDate: '2026-04-05',
      dueDate: '2026-04-12',
      currency: 'SAR',
      lineItems: [
        {
          description: 'Draft expense line',
          quantity: '1',
          unitPrice: '150.00',
          lineTotal: '150.00',
        },
      ],
      subtotal: '150.00',
      total: '150.00',
      notes: '',
    },
    { auditContext: fixture.auditContext }
  );

  const cancelledBill = await createPostedBill(supplierA, {
    amount: '175.00',
    issueDate: '2026-03-10',
    dueDate: '2026-03-20',
  });
  await billService.cancelBill(
    cancelledBill._id,
    fixture.tenant._id,
    fixture.user._id,
    { auditContext: fixture.auditContext }
  );

  const { response, body } = await fetchJson(
    `${serverContext.baseUrl}/api/v1/reports/ap-aging?asOfDate=2026-04-21`,
    {
      headers: {
        Authorization: `Bearer ${fixture.accessToken}`,
      },
    }
  );

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.summary.totalOutstanding, '1900');
  assert.equal(body.data.summary.suppliersWithOutstanding, 2);
  assert.equal(body.data.summary.overdueBillsCount, 3);
  assert.match(body.data.asOfDate, /^2026-04-21T23:59:59\.999Z$/);

  const rowA = body.data.rows.find((row) => row.supplierId === supplierA._id.toString());
  const rowB = body.data.rows.find((row) => row.supplierId === supplierB._id.toString());

  assert.deepEqual(rowA, {
    supplierId: supplierA._id.toString(),
    supplierName: 'Alpha Supplies',
    days0_30: '1000',
    days31_60: '0',
    days61_90: '300',
    days90Plus: '0',
    totalOutstanding: '1300',
  });
  assert.deepEqual(rowB, {
    supplierId: supplierB._id.toString(),
    supplierName: 'Beta Manufacturing',
    days0_30: '200',
    days31_60: '0',
    days61_90: '0',
    days90Plus: '400',
    totalOutstanding: '600',
  });

  const serviceReport = await reportService.getAPAging(fixture.tenant._id, {
    asOfDate: '2026-04-21',
  });

  assert.equal(serviceReport.summary.totalOutstanding, '1900');
  assert.equal(serviceReport.rows.length, 2);

  assert.ok(billA1);
  assert.ok(billB1);
  assert.ok(billB2);
  assert.ok(draftBill);
});
