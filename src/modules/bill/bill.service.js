'use strict';

const mongoose = require('mongoose');
const { Bill } = require('./bill.model');
const BillCounter = require('./billCounter.model');
const { Supplier } = require('../supplier/supplier.model');
const journalService = require('../journal/journal.service');
const taxService = require('../tax/tax.service');
const auditService = require('../audit/audit.service');
const { BadRequestError, NotFoundError } = require('../../common/errors');
const logger = require('../../config/logger');
const { MONEY_FACTOR, toScaledInteger } = require('../../common/utils/money');
const {
  calculateBaseTotals,
  resolveDocumentCurrencySnapshot,
} = require('../currency/currency-snapshot');
const {
  buildBillStatusFilter,
  PAYABLE_BILL_STATUSES,
  resolveBillPaidAmount,
  resolveBillRemainingAmount,
  resolveBillTotalAmount,
  roundMonetaryAmount,
} = require('./bill-status');

class BillService {
  async createBill(tenantId, userId, data, options = {}) {
    const billNumber = await this._getNextBillNumber(tenantId);

    let { supplierName, supplierEmail, supplierId } = data;
    const supplier = await this._resolveSupplier(tenantId, supplierId);
    if (supplier) {
      supplierId = supplier._id.toString();
      supplierName = supplier.name;
      supplierEmail = supplier.email || supplierEmail || '';
    }

    const draftBill = await this._calculateDraftBill(tenantId, this._normalizeDraftBillInput({
      supplierId,
      supplierName,
      supplierEmail,
      issueDate: data.issueDate,
      dueDate: data.dueDate,
      currency: data.currency,
      documentCurrency: data.documentCurrency,
      exchangeRate: data.exchangeRate,
      exchangeRateDate: data.exchangeRateDate,
      exchangeRateSource: data.exchangeRateSource,
      exchangeRateProvider: data.exchangeRateProvider,
      isExchangeRateManualOverride: data.isExchangeRateManualOverride,
      lineItems: data.lineItems,
      subtotal: data.subtotal,
      taxTotal: data.taxTotal,
      total: data.total,
      notes: data.notes,
    }));
    const currencySnapshot = await resolveDocumentCurrencySnapshot(tenantId, draftBill);
    const calculatedBill = this._applyCurrencySnapshot(draftBill, currencySnapshot);
    this._assertValidDraftBill(calculatedBill);

    const bill = await Bill.create({
      tenantId,
      billNumber,
      supplierId: calculatedBill.supplierId || null,
      supplierName: calculatedBill.supplierName,
      supplierEmail: calculatedBill.supplierEmail,
      issueDate: calculatedBill.issueDate,
      dueDate: calculatedBill.dueDate,
      currency: calculatedBill.currency,
      documentCurrency: calculatedBill.documentCurrency,
      baseCurrency: calculatedBill.baseCurrency,
      exchangeRate: mongoose.Types.Decimal128.fromString(calculatedBill.exchangeRate),
      exchangeRateDate: calculatedBill.exchangeRateDate,
      exchangeRateSource: calculatedBill.exchangeRateSource,
      exchangeRateProvider: calculatedBill.exchangeRateProvider,
      isExchangeRateManualOverride: calculatedBill.isExchangeRateManualOverride,
      lineItems: this._buildLineItems(calculatedBill.lineItems),
      subtotal: mongoose.Types.Decimal128.fromString(calculatedBill.subtotal),
      taxTotal: mongoose.Types.Decimal128.fromString(calculatedBill.taxTotal),
      total: mongoose.Types.Decimal128.fromString(calculatedBill.total),
      baseSubtotal: mongoose.Types.Decimal128.fromString(calculatedBill.baseSubtotal),
      baseTaxTotal: mongoose.Types.Decimal128.fromString(calculatedBill.baseTaxTotal),
      baseTotal: mongoose.Types.Decimal128.fromString(calculatedBill.baseTotal),
      paidAmount: 0,
      remainingAmount: Number(calculatedBill.total),
      payments: [],
      notes: calculatedBill.notes,
      status: 'draft',
      createdBy: userId,
    });

    await auditService.log({
      tenantId,
      userId,
      action: 'bill.created',
      resourceType: 'Bill',
      resourceId: bill._id,
      newValues: { billNumber, supplierName: bill.supplierName },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, billId: bill._id, billNumber }, 'Bill created');
    return bill;
  }

  async listBills(tenantId, { skip, limit, status, search, dateFrom, dateTo, minAmount, maxAmount } = {}) {
    const filter = this._buildListFilter(tenantId, {
      status,
      search,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
    });

    const [bills, total] = await Promise.all([
      Bill.find(filter)
        .populate({ path: 'createdBy', select: 'name email', match: { tenantId } })
        .sort({ issueDate: -1, billNumber: -1 })
        .skip(skip)
        .limit(limit),
      Bill.countDocuments(filter),
    ]);

    return { bills, total };
  }

  async exportBills(tenantId, { status, search, dateFrom, dateTo, minAmount, maxAmount } = {}) {
    const filter = this._buildListFilter(tenantId, {
      status,
      search,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
    });

    return Bill.find(filter)
      .select('billNumber supplierName status total paidAmount remainingAmount issueDate dueDate')
      .sort({ issueDate: -1, billNumber: -1 })
      .lean();
  }

  async getBillById(billId, tenantId) {
    const bill = await Bill.findOne({ _id: billId, tenantId })
      .populate({ path: 'createdBy', select: 'name email', match: { tenantId } })
      .populate({ path: 'supplierId', select: 'name email phone', match: { tenantId } })
      .populate({
        path: 'apAccountId',
        select: 'code nameAr nameEn',
        match: { tenantId },
      })
      .populate({
        path: 'postedJournalEntryId',
        select: 'entryNumber date status',
        match: { tenantId },
      })
      .populate({
        path: 'paymentJournalEntryId',
        select: 'entryNumber date status',
        match: { tenantId },
      })
      .populate({
        path: 'payments.accountId',
        select: 'code nameAr nameEn',
        match: { tenantId },
      })
      .populate({
        path: 'payments.journalEntryId',
        select: 'entryNumber date status',
        match: { tenantId },
      });

    if (!bill) throw new NotFoundError('Bill not found');
    return bill;
  }

  async updateBill(billId, tenantId, userId, data, options = {}) {
    const bill = await Bill.findOne({ _id: billId, tenantId });
    if (!bill) throw new NotFoundError('Bill not found');
    if (bill.status !== 'draft') {
      throw new BadRequestError('Only draft bills can be edited');
    }

    let supplierId = bill.supplierId ? bill.supplierId.toString() : null;
    let supplierName = bill.supplierName;
    let supplierEmail = bill.supplierEmail || '';

    if (data.supplierId !== undefined) {
      if (data.supplierId) {
        const supplier = await this._resolveSupplier(tenantId, data.supplierId);
        supplierId = supplier._id.toString();
        supplierName = supplier.name;
        supplierEmail = supplier.email || supplierEmail;
      } else {
        supplierId = null;
        if (data.supplierName !== undefined) supplierName = data.supplierName;
        if (data.supplierEmail !== undefined) supplierEmail = data.supplierEmail;
      }
    } else {
      if (data.supplierName !== undefined) supplierName = data.supplierName;
      if (data.supplierEmail !== undefined) supplierEmail = data.supplierEmail;
    }

    const draftBill = await this._calculateDraftBill(tenantId, this._normalizeDraftBillInput({
      supplierId,
      supplierName,
      supplierEmail,
      issueDate: data.issueDate ?? bill.issueDate,
      dueDate: data.dueDate ?? bill.dueDate,
      currency: data.currency,
      documentCurrency: data.documentCurrency,
      exchangeRate: data.exchangeRate,
      exchangeRateDate: data.exchangeRateDate,
      exchangeRateSource: data.exchangeRateSource,
      exchangeRateProvider: data.exchangeRateProvider,
      isExchangeRateManualOverride: data.isExchangeRateManualOverride,
      lineItems: data.lineItems ?? this._serializeLineItems(bill.lineItems),
      subtotal: data.subtotal ?? bill.subtotal,
      taxTotal: data.taxTotal ?? bill.taxTotal,
      total: data.total ?? bill.total,
      notes: data.notes !== undefined ? data.notes : bill.notes,
    }));
    const currencySnapshot = await resolveDocumentCurrencySnapshot(tenantId, draftBill, bill);
    const calculatedBill = this._applyCurrencySnapshot(draftBill, currencySnapshot);
    this._assertValidDraftBill(calculatedBill);

    bill.supplierId = calculatedBill.supplierId || null;
    bill.supplierName = calculatedBill.supplierName;
    bill.supplierEmail = calculatedBill.supplierEmail;
    bill.issueDate = calculatedBill.issueDate;
    bill.dueDate = calculatedBill.dueDate;
    bill.currency = calculatedBill.currency;
    bill.documentCurrency = calculatedBill.documentCurrency;
    bill.baseCurrency = calculatedBill.baseCurrency;
    bill.exchangeRate = mongoose.Types.Decimal128.fromString(calculatedBill.exchangeRate);
    bill.exchangeRateDate = calculatedBill.exchangeRateDate;
    bill.exchangeRateSource = calculatedBill.exchangeRateSource;
    bill.exchangeRateProvider = calculatedBill.exchangeRateProvider;
    bill.isExchangeRateManualOverride = calculatedBill.isExchangeRateManualOverride;
    bill.notes = calculatedBill.notes;
    bill.lineItems = this._buildLineItems(calculatedBill.lineItems);
    bill.subtotal = mongoose.Types.Decimal128.fromString(calculatedBill.subtotal);
    bill.taxTotal = mongoose.Types.Decimal128.fromString(calculatedBill.taxTotal);
    bill.total = mongoose.Types.Decimal128.fromString(calculatedBill.total);
    bill.baseSubtotal = mongoose.Types.Decimal128.fromString(calculatedBill.baseSubtotal);
    bill.baseTaxTotal = mongoose.Types.Decimal128.fromString(calculatedBill.baseTaxTotal);
    bill.baseTotal = mongoose.Types.Decimal128.fromString(calculatedBill.baseTotal);
    bill.paidAmount = 0;
    bill.remainingAmount = Number(calculatedBill.total);

    await bill.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'bill.updated',
      resourceType: 'Bill',
      resourceId: bill._id,
      newValues: { billNumber: bill.billNumber },
      auditContext: options.auditContext,
    });

    return bill;
  }

  async postBill(billId, tenantId, userId, { apAccountId, debitAccountId }, options = {}) {
    const bill = await Bill.findOne({ _id: billId, tenantId });
    if (!bill) throw new NotFoundError('Bill not found');
    if (bill.status !== 'draft') {
      throw new BadRequestError('Only draft bills can be posted');
    }

    this._assertValidDraftBill(this._normalizeDraftBillInput({
      supplierId: bill.supplierId,
      supplierName: bill.supplierName,
      supplierEmail: bill.supplierEmail,
      issueDate: bill.issueDate,
      dueDate: bill.dueDate,
      currency: bill.currency,
      lineItems: this._serializeLineItems(bill.lineItems),
      subtotal: bill.subtotal,
      taxTotal: bill.taxTotal,
      total: bill.total,
      notes: bill.notes,
    }));

    const { subtotalStr, taxTotalStr, totalStr } = this._resolvePostingAmounts(bill);
    const documentTotalStr = bill.total.toString();
    const postDescription = `Bill posted - ${bill.billNumber}`;
    const lines = [
      { accountId: debitAccountId, debit: subtotalStr, credit: '0' },
      { accountId: apAccountId, debit: '0', credit: totalStr },
    ];

    if (toScaledInteger(taxTotalStr) > 0n) {
      const inputVatAccount = await taxService.resolveInputVatAccount(tenantId);
      lines.splice(1, 0, {
        accountId: inputVatAccount._id.toString(),
        debit: taxTotalStr,
        credit: '0',
      });
    }

    const entry = await journalService.createEntry(
      tenantId,
      userId,
      {
        date: bill.issueDate.toISOString(),
        description: postDescription,
        reference: bill.billNumber,
        lines: lines.map((line) => ({ ...line, description: postDescription })),
      },
      { auditContext: options.auditContext }
    );

    await journalService.postEntry(entry._id, tenantId, userId, { auditContext: options.auditContext });

    bill.status = 'posted';
    bill.apAccountId = apAccountId;
    bill.paidAmount = 0;
    bill.remainingAmount = roundMonetaryAmount(Number(documentTotalStr));
    bill.postedAt = new Date();
    bill.postedJournalEntryId = entry._id;
    await bill.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'bill.posted',
      resourceType: 'Bill',
      resourceId: bill._id,
      newValues: { billNumber: bill.billNumber, journalEntryId: entry._id },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, billId, entryId: entry._id }, 'Bill posted');
    return bill;
  }

  async recordPayment(billId, tenantId, userId, { cashAccountId, amount, paymentDate }, options = {}) {
    const bill = await Bill.findOne({ _id: billId, tenantId });
    if (!bill) throw new NotFoundError('Bill not found');
    if (!PAYABLE_BILL_STATUSES.includes(bill.status)) {
      throw new BadRequestError('Only posted, overdue, or partially paid bills can be paid');
    }

    const totalAmount = resolveBillTotalAmount(bill);
    const paidAmount = resolveBillPaidAmount(bill, totalAmount);
    const remainingAmount = resolveBillRemainingAmount(bill, totalAmount, paidAmount);
    const paymentAmount = roundMonetaryAmount(Number(amount));

    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      throw new BadRequestError('Payment amount must be greater than zero');
    }
    if (remainingAmount <= 0) {
      throw new BadRequestError('Bill has no remaining amount to pay');
    }
    if (paymentAmount > remainingAmount) {
      throw new BadRequestError('Payment amount cannot exceed remaining amount');
    }

    const apAccountId = bill.apAccountId?._id
      ? bill.apAccountId._id.toString()
      : bill.apAccountId?.toString();
    if (!apAccountId) {
      throw new BadRequestError('Bill has no stored accounts payable account');
    }

    const amountStr = paymentAmount.toFixed(6).replace(/\.?0+$/, '');
    const date = paymentDate ? new Date(paymentDate) : new Date();
    const paymentDescription = `Bill payment - ${bill.billNumber}`;

    const entry = await journalService.createEntry(
      tenantId,
      userId,
      {
        date: date.toISOString(),
        description: paymentDescription,
        reference: bill.billNumber,
        lines: [
          { accountId: apAccountId, debit: amountStr, credit: '0' },
          { accountId: cashAccountId, debit: '0', credit: amountStr },
        ].map((line) => ({ ...line, description: paymentDescription })),
      },
      { auditContext: options.auditContext }
    );

    await journalService.postEntry(entry._id, tenantId, userId, { auditContext: options.auditContext });

    bill.paidAmount = roundMonetaryAmount(paidAmount + paymentAmount);
    bill.remainingAmount = roundMonetaryAmount(totalAmount - bill.paidAmount);
    if (bill.remainingAmount < 0) bill.remainingAmount = 0;
    bill.payments.push({
      amount: paymentAmount,
      date,
      accountId: cashAccountId,
      journalEntryId: entry._id,
    });
    bill.status = bill.remainingAmount === 0
      ? 'paid'
      : bill.paidAmount > 0
        ? 'partially_paid'
        : 'posted';
    bill.paidAt = bill.remainingAmount === 0 ? new Date() : null;
    bill.paymentJournalEntryId = entry._id;
    await bill.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'bill.paid',
      resourceType: 'Bill',
      resourceId: bill._id,
      newValues: { billNumber: bill.billNumber, journalEntryId: entry._id, amount: paymentAmount },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, billId, entryId: entry._id, amount: paymentAmount }, 'Bill payment recorded');
    return bill;
  }

  async bulkCancelBills(billIds, tenantId, userId, options = {}) {
    const uniqueBillIds = this._normalizeBulkIds(billIds);
    const bills = await Bill.find({ _id: { $in: uniqueBillIds }, tenantId });

    if (bills.length !== uniqueBillIds.length) {
      throw new NotFoundError('One or more bills not found');
    }

    if (bills.some((bill) => !this._canCancelBill(bill))) {
      throw new BadRequestError('One or more selected bills cannot be cancelled');
    }

    for (const billId of uniqueBillIds) {
      await this.cancelBill(billId, tenantId, userId, options);
    }

    return { count: uniqueBillIds.length };
  }

  async cancelBill(billId, tenantId, userId, options = {}) {
    const bill = await Bill.findOne({ _id: billId, tenantId });
    if (!bill) throw new NotFoundError('Bill not found');
    if (bill.status === 'cancelled') {
      throw new BadRequestError('Bill is already cancelled');
    }
    if (bill.status === 'paid') {
      throw new BadRequestError('Paid bills cannot be cancelled');
    }
    if (!this._canCancelBill(bill)) {
      throw new BadRequestError('Bills with recorded payments cannot be cancelled');
    }

    bill.status = 'cancelled';
    bill.cancelledAt = new Date();
    await bill.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'bill.cancelled',
      resourceType: 'Bill',
      resourceId: bill._id,
      newValues: { billNumber: bill.billNumber },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, billId }, 'Bill cancelled');
    return bill;
  }

  _buildLineItems(items) {
    return items.map((item) => ({
      description: item.description,
      quantity: mongoose.Types.Decimal128.fromString(this._moneyToString(item.quantity)),
      unitPrice: mongoose.Types.Decimal128.fromString(this._moneyToString(item.unitPrice)),
      lineSubtotal: mongoose.Types.Decimal128.fromString(this._moneyToString(item.lineSubtotal)),
      taxRateId: item.taxRateId || null,
      taxRate: mongoose.Types.Decimal128.fromString(this._moneyToString(item.taxRate || '0')),
      taxAmount: mongoose.Types.Decimal128.fromString(this._moneyToString(item.taxAmount || '0')),
      lineTotal: mongoose.Types.Decimal128.fromString(this._moneyToString(item.lineTotal)),
      lineBaseSubtotal: mongoose.Types.Decimal128.fromString(
        this._moneyToString(item.lineBaseSubtotal || '0')
      ),
      lineBaseTaxAmount: mongoose.Types.Decimal128.fromString(
        this._moneyToString(item.lineBaseTaxAmount || '0')
      ),
      lineBaseTotal: mongoose.Types.Decimal128.fromString(
        this._moneyToString(item.lineBaseTotal || '0')
      ),
    }));
  }

  _serializeLineItems(items) {
    return (items || []).map((item) => ({
      description: item.description,
      quantity: this._moneyToString(item.quantity),
      unitPrice: this._moneyToString(item.unitPrice),
      lineSubtotal: this._moneyToString(item.lineSubtotal || item.lineTotal),
      taxRateId: item.taxRateId?.toString?.() || null,
      taxRate: this._moneyToString(item.taxRate || '0'),
      taxAmount: this._moneyToString(item.taxAmount || '0'),
      lineTotal: this._moneyToString(item.lineTotal),
      lineBaseSubtotal: this._moneyToString(item.lineBaseSubtotal || '0'),
      lineBaseTaxAmount: this._moneyToString(item.lineBaseTaxAmount || '0'),
      lineBaseTotal: this._moneyToString(item.lineBaseTotal || '0'),
    }));
  }

  _normalizeDraftBillInput(data) {
    return {
      supplierId: this._normalizeOptionalObjectId(data.supplierId, 'Supplier ID'),
      supplierName: data.supplierName,
      supplierEmail: data.supplierEmail || '',
      issueDate: data.issueDate instanceof Date ? data.issueDate : new Date(data.issueDate),
      dueDate: data.dueDate instanceof Date ? data.dueDate : new Date(data.dueDate),
      currency: data.currency || '',
      documentCurrency: data.documentCurrency || '',
      exchangeRate: data.exchangeRate,
      exchangeRateDate: data.exchangeRateDate,
      exchangeRateSource: data.exchangeRateSource,
      exchangeRateProvider: data.exchangeRateProvider,
      isExchangeRateManualOverride: data.isExchangeRateManualOverride,
      lineItems: Array.isArray(data.lineItems)
        ? data.lineItems.map((item) => ({
          description: item.description,
          quantity: this._moneyToString(item.quantity),
          unitPrice: this._moneyToString(item.unitPrice),
          lineSubtotal: this._moneyToString(item.lineSubtotal || item.lineTotal),
          taxRateId: this._normalizeOptionalObjectId(item.taxRateId, 'Tax rate ID'),
          taxRate: this._moneyToString(item.taxRate || '0'),
          taxAmount: this._moneyToString(item.taxAmount || '0'),
          lineTotal: this._moneyToString(item.lineTotal),
        }))
        : [],
      subtotal: this._moneyToString(data.subtotal),
      taxTotal: this._moneyToString(data.taxTotal || '0'),
      total: this._moneyToString(data.total),
      notes: data.notes || '',
    };
  }

  _applyCurrencySnapshot(bill, snapshot) {
    const baseTotals = calculateBaseTotals(bill.lineItems, snapshot.exchangeRate);

    return {
      ...bill,
      ...snapshot,
      lineItems: baseTotals.lineItems,
      baseSubtotal: baseTotals.baseSubtotal,
      baseTaxTotal: baseTotals.baseTaxTotal,
      baseTotal: baseTotals.baseTotal,
    };
  }

  _resolvePostingAmounts(bill) {
    const documentCurrency = this._normalizePostingCurrency(
      bill.documentCurrency || bill.currency || ''
    );
    const baseCurrency = this._normalizePostingCurrency(bill.baseCurrency || 'SAR');
    const sameCurrency = !documentCurrency || documentCurrency === baseCurrency;

    const documentAmounts = {
      subtotalStr: this._moneyToString(bill.subtotal || '0'),
      taxTotalStr: this._moneyToString(bill.taxTotal || '0'),
      totalStr: this._moneyToString(bill.total || '0'),
    };
    const baseAmounts = {
      subtotalStr: this._moneyToString(bill.baseSubtotal || '0'),
      taxTotalStr: this._moneyToString(bill.baseTaxTotal || '0'),
      totalStr: this._moneyToString(bill.baseTotal || '0'),
    };

    if (this._hasUsableBasePostingAmounts(baseAmounts, documentAmounts)) {
      return baseAmounts;
    }

    if (sameCurrency) {
      return documentAmounts;
    }

    throw new BadRequestError(
      'Base currency amounts are required before posting foreign-currency documents',
      'BASE_AMOUNTS_REQUIRED'
    );
  }

  _hasUsableBasePostingAmounts(baseAmounts, documentAmounts) {
    const baseSubtotal = this._parseMoney(baseAmounts.subtotalStr, 'Bill base subtotal');
    const baseTaxTotal = this._parseMoney(baseAmounts.taxTotalStr, 'Bill base tax total');
    const baseTotal = this._parseMoney(baseAmounts.totalStr, 'Bill base total');
    const documentTaxTotal = this._parseMoney(documentAmounts.taxTotalStr, 'Bill tax total');

    return (
      baseSubtotal > 0n &&
      baseTotal > 0n &&
      baseTaxTotal >= 0n &&
      (documentTaxTotal === 0n || baseTaxTotal > 0n)
    );
  }

  _normalizePostingCurrency(value) {
    return this._moneyToString(value).toUpperCase();
  }

  async _calculateDraftBill(tenantId, bill) {
    const taxRatesById = await taxService.getTaxRatesForLines(
      tenantId,
      bill.lineItems,
      ['purchase', 'both']
    );
    const calculated = taxService.calculateLinesTax(bill.lineItems, taxRatesById);

    return {
      ...bill,
      lineItems: calculated.lineItems,
      subtotal: calculated.subtotal,
      taxTotal: calculated.taxTotal,
      total: calculated.total,
    };
  }

  _assertValidDraftBill(bill) {
    if (!Array.isArray(bill.lineItems) || bill.lineItems.length === 0) {
      throw new BadRequestError('Bill must contain at least one line item');
    }

    const subtotal = this._parseMoney(bill.subtotal, 'Bill subtotal');
    const taxTotal = this._parseMoney(bill.taxTotal || '0', 'Bill tax total');
    const total = this._parseMoney(bill.total, 'Bill total');
    let subtotalFromLines = 0n;
    let taxTotalFromLines = 0n;
    let totalFromLines = 0n;

    bill.lineItems.forEach((item, index) => {
      const lineNumber = index + 1;
      const quantity = this._parseMoney(item.quantity, `Bill line ${lineNumber} quantity`);
      const unitPrice = this._parseMoney(item.unitPrice, `Bill line ${lineNumber} unit price`);
      const lineSubtotal = this._parseMoney(
        item.lineSubtotal,
        `Bill line ${lineNumber} line subtotal`
      );
      const taxRate = this._parseMoney(item.taxRate || '0', `Bill line ${lineNumber} tax rate`);
      const taxAmount = this._parseMoney(
        item.taxAmount || '0',
        `Bill line ${lineNumber} tax amount`
      );
      const lineTotal = this._parseMoney(item.lineTotal, `Bill line ${lineNumber} line total`);

      if (quantity <= 0n) {
        throw new BadRequestError(`Bill line ${lineNumber} quantity must be greater than zero`);
      }
      if (unitPrice < 0n) {
        throw new BadRequestError(`Bill line ${lineNumber} unit price cannot be negative`);
      }
      if (lineSubtotal < 0n) {
        throw new BadRequestError(`Bill line ${lineNumber} line subtotal cannot be negative`);
      }
      if (taxRate < 0n || taxRate > 100n * MONEY_FACTOR) {
        throw new BadRequestError(`Bill line ${lineNumber} tax rate must be between 0 and 100`);
      }
      if (taxAmount < 0n) {
        throw new BadRequestError(`Bill line ${lineNumber} tax amount cannot be negative`);
      }
      if (lineTotal < 0n) {
        throw new BadRequestError(`Bill line ${lineNumber} line total cannot be negative`);
      }

      const expectedLineSubtotal = ((quantity * unitPrice) + (MONEY_FACTOR / 2n)) / MONEY_FACTOR;
      if (lineSubtotal !== expectedLineSubtotal) {
        throw new BadRequestError(`Bill line ${lineNumber} line subtotal must equal quantity x unit price`);
      }
      if (lineTotal !== lineSubtotal + taxAmount) {
        throw new BadRequestError(
          `Bill line ${lineNumber} line total must equal line subtotal plus tax amount`
        );
      }

      subtotalFromLines += lineSubtotal;
      taxTotalFromLines += taxAmount;
      totalFromLines += lineTotal;
    });

    if (subtotal <= 0n) {
      throw new BadRequestError('Bill subtotal must be greater than zero');
    }
    if (taxTotal < 0n) {
      throw new BadRequestError('Bill tax total cannot be negative');
    }
    if (total <= 0n) {
      throw new BadRequestError('Bill total must be greater than zero');
    }
    if (subtotal !== subtotalFromLines) {
      throw new BadRequestError('Bill subtotal must equal the sum of line subtotals');
    }
    if (taxTotal !== taxTotalFromLines) {
      throw new BadRequestError('Bill tax total must equal the sum of line tax amounts');
    }
    if (total !== totalFromLines || total !== subtotal + taxTotal) {
      throw new BadRequestError('Bill total must equal subtotal plus tax total');
    }
  }

  _parseMoney(value, label) {
    try {
      return toScaledInteger(this._moneyToString(value));
    } catch (_error) {
      throw new BadRequestError(`${label} must be a valid decimal amount`);
    }
  }

  _moneyToString(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    if (typeof value?.toString === 'function') return value.toString();
    return String(value);
  }

  _normalizeOptionalObjectId(value, label) {
    const normalized = typeof value === 'string' ? value.trim() : value?.toString?.() ?? '';
    if (!normalized) {
      return null;
    }

    if (!mongoose.Types.ObjectId.isValid(normalized)) {
      throw new BadRequestError(`${label} must be a valid ObjectId`);
    }

    return normalized;
  }

  async _resolveSupplier(tenantId, supplierId) {
    const normalizedSupplierId = this._normalizeOptionalObjectId(supplierId, 'Supplier ID');
    if (!normalizedSupplierId) {
      return null;
    }

    const supplier = await Supplier.findOne({
      _id: normalizedSupplierId,
      tenantId,
      deletedAt: null,
    });

    if (!supplier) {
      throw new NotFoundError('Supplier not found');
    }

    return supplier;
  }

  _canCancelBill(bill) {
    if (!bill || ['paid', 'cancelled', 'partially_paid'].includes(bill.status)) {
      return false;
    }

    const totalAmount = resolveBillTotalAmount(bill);
    const paidAmount = resolveBillPaidAmount(bill, totalAmount);
    const hasPayments = Array.isArray(bill.payments) && bill.payments.length > 0;

    return paidAmount <= 0 && !hasPayments;
  }

  _buildListFilter(tenantId, { status, search, dateFrom, dateTo, minAmount, maxAmount }) {
    const filter = { tenantId, deletedAt: null };
    const andFilters = [
      this._buildStatusListFilter(status),
      this._buildDateRangeFilter(dateFrom, dateTo),
      this._buildAmountRangeFilter(minAmount, maxAmount),
      this._buildSearchFilter(search),
    ].filter(Boolean);

    if (andFilters.length > 0) {
      filter.$and = andFilters;
    }

    return filter;
  }

  _buildStatusListFilter(status) {
    if (!status) return null;
    return buildBillStatusFilter(status);
  }

  _buildDateRangeFilter(dateFrom, dateTo) {
    const issueDateFilter = {};
    const fromDate = this._parseDateFilter(dateFrom);
    const toDate = this._parseDateFilter(dateTo, true);

    if (fromDate) issueDateFilter.$gte = fromDate;
    if (toDate) issueDateFilter.$lte = toDate;

    return Object.keys(issueDateFilter).length > 0 ? { issueDate: issueDateFilter } : null;
  }

  _buildAmountRangeFilter(minAmount, maxAmount) {
    const totalFilter = {};
    const min = this._parseDecimalFilter(minAmount);
    const max = this._parseDecimalFilter(maxAmount);

    if (min) totalFilter.$gte = min;
    if (max) totalFilter.$lte = max;

    return Object.keys(totalFilter).length > 0 ? { total: totalFilter } : null;
  }

  _buildSearchFilter(search) {
    const regex = this._buildSearchRegex(search);
    if (!regex) return null;

    return {
      $or: [
        { supplierName: regex },
        { billNumber: regex },
      ],
    };
  }

  _buildSearchRegex(search) {
    const value = typeof search === 'string' ? search.trim() : '';
    if (!value) return null;

    try {
      return new RegExp(value, 'i');
    } catch (_error) {
      return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  }

  _parseDateFilter(value, endOfDay = false) {
    if (!value) return null;

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;

    if (endOfDay) {
      parsed.setUTCHours(23, 59, 59, 999);
    }

    return parsed;
  }

  _parseDecimalFilter(value) {
    if (value === undefined || value === null || value === '') return null;

    try {
      return mongoose.Types.Decimal128.fromString(String(value));
    } catch (_error) {
      return null;
    }
  }

  _normalizeBulkIds(ids) {
    const uniqueIds = [...new Set((ids || []).map((id) => String(id)).filter(Boolean))];
    if (uniqueIds.length === 0) {
      throw new BadRequestError('At least one bill is required');
    }
    return uniqueIds;
  }

  async _getNextBillNumber(tenantId) {
    const key = 'bill';
    const counter = await BillCounter.findOneAndUpdate(
      { tenantId, key },
      { $inc: { sequence: 1 } },
      { returnDocument: 'after' }
    );

    if (counter) {
      return `BILL-${String(counter.sequence).padStart(4, '0')}`;
    }

    const last = await Bill.findOne({ tenantId })
      .sort({ createdAt: -1 })
      .select('billNumber')
      .setOptions({ __includeDeleted: true });

    const lastNum = last ? parseInt(last.billNumber.replace('BILL-', ''), 10) : 0;
    const initialSequence = (isNaN(lastNum) ? 0 : lastNum) + 1;

    try {
      const created = await BillCounter.create({ tenantId, key, sequence: initialSequence });
      return `BILL-${String(created.sequence).padStart(4, '0')}`;
    } catch (error) {
      if (error.code === 11000) {
        const retry = await BillCounter.findOneAndUpdate(
          { tenantId, key },
          { $inc: { sequence: 1 } },
          { returnDocument: 'after' }
        );
        return `BILL-${String(retry.sequence).padStart(4, '0')}`;
      }

      throw error;
    }
  }
}

module.exports = new BillService();
