'use strict';

const { Supplier } = require('./supplier.model');
const { Bill } = require('../bill/bill.model');
const {
  PAYABLE_BILL_STATUSES,
  resolveBillPaidAmount,
  resolveBillRemainingAmount,
  resolveBillStatus,
  resolveBillTotalAmount,
  roundMonetaryAmount,
} = require('../bill/bill-status');
const auditService = require('../audit/audit.service');
const { NotFoundError } = require('../../common/errors');
const { buildPaginationMeta } = require('../../common/utils/response');

const BILL_STATEMENT_STATUSES = ['posted', ...PAYABLE_BILL_STATUSES, 'paid'];
const FOREIGN_CURRENCY_BALANCES_WARNING = 'FOREIGN_CURRENCY_BALANCES_UNSUPPORTED';

class SupplierService {
  async listSuppliers(tenantId, { limit = 20, skip = 0, search } = {}) {
    const filter = { tenantId, deletedAt: null };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const [suppliers, total] = await Promise.all([
      Supplier.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
      Supplier.countDocuments(filter),
    ]);

    return { suppliers, total };
  }

  async getSupplierById(supplierId, tenantId) {
    const supplier = await Supplier.findOne({ _id: supplierId, tenantId, deletedAt: null });
    if (!supplier) throw new NotFoundError('Supplier not found');
    return supplier;
  }

  async getSupplierBills(supplierId, tenantId) {
    const supplier = await Supplier.findOne({ _id: supplierId, tenantId, deletedAt: null }).lean();
    if (!supplier) throw new NotFoundError('Supplier not found');

    const bills = await Bill.find({ supplierId, tenantId, deletedAt: null })
      .sort({ issueDate: -1, billNumber: -1 })
      .lean();

    let totalBilled = 0;
    let totalPaid = 0;
    let outstandingBalance = 0;
    const detailedBills = [];
    const foreignDocuments = [];

    for (const bill of bills) {
      const status = resolveBillStatus(bill);
      const amount = resolveBillTotalAmount(bill);
      const paidAmount = resolveBillPaidAmount(bill, amount);
      const remainingAmount = resolveBillRemainingAmount(bill, amount, paidAmount);

      detailedBills.push({
        ...bill,
        status,
        total: amount,
        paidAmount,
        remainingAmount,
      });

      if (!BILL_STATEMENT_STATUSES.includes(status)) {
        continue;
      }
      if (this._isForeignCurrencyDocument(bill)) {
        foreignDocuments.push(this._formatUnsupportedForeignDocument(bill));
        continue;
      }

      totalBilled = roundMonetaryAmount(totalBilled + amount);
      totalPaid = roundMonetaryAmount(totalPaid + paidAmount);
      outstandingBalance = roundMonetaryAmount(outstandingBalance + remainingAmount);
    }

    return {
      supplier,
      bills: detailedBills,
      summary: {
        totalBilled,
        totalPaid,
        outstandingBalance,
        currency: this._getSummaryBaseCurrency(bills),
        amountsIn: 'baseCurrency',
        excludedForeignDocumentsCount: foreignDocuments.length,
      },
      warnings: this._buildForeignCurrencyBalanceWarnings('Supplier bill summary', foreignDocuments),
    };
  }

  async getSupplierStatement(supplierId, tenantId, { page = 1, limit = 20 } = {}) {
    const supplier = await Supplier.findOne({ _id: supplierId, tenantId, deletedAt: null }).lean();
    if (!supplier) throw new NotFoundError('Supplier not found');

    const bills = await Bill.find({ supplierId, tenantId, deletedAt: null })
      .sort({ issueDate: 1, billNumber: 1 })
      .lean();

    let totalBilled = 0;
    let totalPaid = 0;
    let outstandingBalance = 0;
    const entries = [];
    const foreignDocuments = [];

    for (const bill of bills) {
      const billStatus = resolveBillStatus(bill);
      if (!BILL_STATEMENT_STATUSES.includes(billStatus)) {
        continue;
      }
      if (this._isForeignCurrencyDocument(bill)) {
        foreignDocuments.push(this._formatUnsupportedForeignDocument(bill));
        continue;
      }

      const amount = resolveBillTotalAmount(bill);
      const paidAmount = resolveBillPaidAmount(bill, amount);
      const remainingAmount = resolveBillRemainingAmount(bill, amount, paidAmount);

      totalBilled = roundMonetaryAmount(totalBilled + amount);
      totalPaid = roundMonetaryAmount(totalPaid + paidAmount);
      outstandingBalance = roundMonetaryAmount(outstandingBalance + remainingAmount);

      entries.push({
        type: 'bill',
        date: bill.issueDate,
        reference: bill.billNumber,
        billNumber: bill.billNumber,
        debit: 0,
        credit: amount,
        billId: bill._id,
        journalEntryId: bill.postedJournalEntryId || null,
        currency: this._getDocumentBaseCurrency(bill),
        documentCurrency: this._getDocumentCurrency(bill),
        _sortDate: new Date(bill.issueDate).getTime(),
        _sortPriority: 0,
        _sortKey: `${bill.billNumber}:${bill._id}`,
      });

      const payments = Array.isArray(bill.payments) ? [...bill.payments] : [];
      payments
        .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())
        .forEach((payment, index) => {
          const paymentAmount = roundMonetaryAmount(Number(payment.amount ?? 0));
          if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) return;

          entries.push({
            type: 'payment',
            date: payment.date,
            reference: bill.billNumber,
            billNumber: bill.billNumber,
            debit: paymentAmount,
            credit: 0,
            billId: bill._id,
            journalEntryId: payment.journalEntryId || null,
            currency: this._getDocumentBaseCurrency(bill),
            documentCurrency: this._getDocumentCurrency(bill),
            _sortDate: new Date(payment.date).getTime(),
            _sortPriority: 1,
            _sortKey: `${bill.billNumber}:${index}`,
          });
        });
    }

    entries.sort((left, right) => (
      left._sortDate - right._sortDate
      || left._sortPriority - right._sortPriority
      || String(left._sortKey).localeCompare(String(right._sortKey))
    ));

    let runningBalance = 0;
    const transactions = entries.map(({ _sortDate, _sortPriority, _sortKey, ...entry }) => {
      runningBalance = roundMonetaryAmount(runningBalance + entry.credit - entry.debit);

      return {
        ...entry,
        billId: entry.billId?.toString?.() ?? entry.billId,
        journalEntryId: entry.journalEntryId?.toString?.() ?? null,
        runningBalance,
      };
    });

    const pagination = buildPaginationMeta(page, limit, transactions.length);
    const paginatedTransactions = transactions.slice((page - 1) * limit, page * limit);

    return {
      supplier,
      summary: {
        totalBilled,
        totalPaid,
        outstandingBalance,
        currency: this._getSummaryBaseCurrency(bills),
        amountsIn: 'baseCurrency',
        excludedForeignDocumentsCount: foreignDocuments.length,
      },
      transactions: paginatedTransactions,
      pagination,
      warnings: this._buildForeignCurrencyBalanceWarnings('Supplier statement', foreignDocuments),
    };
  }

  async createSupplier(tenantId, userId, data, options = {}) {
    const supplier = await Supplier.create({
      tenantId,
      name: data.name,
      email: data.email || '',
      phone: data.phone || '',
      address: data.address || '',
      notes: data.notes || '',
    });

    await auditService.log({
      tenantId,
      userId,
      action: 'supplier.created',
      resourceType: 'Supplier',
      resourceId: supplier._id,
      newValues: { name: supplier.name },
      auditContext: options.auditContext,
    });

    return supplier;
  }

  async updateSupplier(supplierId, tenantId, userId, data, options = {}) {
    const supplier = await Supplier.findOne({ _id: supplierId, tenantId, deletedAt: null });
    if (!supplier) throw new NotFoundError('Supplier not found');

    if (data.name !== undefined) supplier.name = data.name;
    if (data.email !== undefined) supplier.email = data.email;
    if (data.phone !== undefined) supplier.phone = data.phone;
    if (data.address !== undefined) supplier.address = data.address;
    if (data.notes !== undefined) supplier.notes = data.notes;

    await supplier.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'supplier.updated',
      resourceType: 'Supplier',
      resourceId: supplier._id,
      newValues: { name: supplier.name },
      auditContext: options.auditContext,
    });

    return supplier;
  }

  async deleteSupplier(supplierId, tenantId, userId, options = {}) {
    const supplier = await Supplier.findOne({ _id: supplierId, tenantId, deletedAt: null });
    if (!supplier) throw new NotFoundError('Supplier not found');

    await supplier.softDelete();

    await auditService.log({
      tenantId,
      userId,
      action: 'supplier.deleted',
      resourceType: 'Supplier',
      resourceId: supplier._id,
      newValues: { name: supplier.name },
      auditContext: options.auditContext,
    });
  }

  _normalizeCurrencyCode(value, fallback = 'SAR') {
    const normalized = value?.toString?.().trim().toUpperCase();
    return /^[A-Z]{3}$/.test(normalized || '') ? normalized : fallback;
  }

  _getDocumentBaseCurrency(bill, fallbackBaseCurrency = 'SAR') {
    return this._normalizeCurrencyCode(bill?.baseCurrency, fallbackBaseCurrency);
  }

  _getDocumentCurrency(bill, fallbackBaseCurrency = 'SAR') {
    const baseCurrency = this._getDocumentBaseCurrency(bill, fallbackBaseCurrency);
    return this._normalizeCurrencyCode(
      bill?.documentCurrency || bill?.currency || baseCurrency,
      baseCurrency
    );
  }

  _isForeignCurrencyDocument(bill) {
    const baseCurrency = this._getDocumentBaseCurrency(bill);
    const documentCurrency = this._getDocumentCurrency(bill, baseCurrency);
    return documentCurrency !== baseCurrency;
  }

  _getSummaryBaseCurrency(bills) {
    const bill = bills.find((item) => item?.baseCurrency);
    return this._getDocumentBaseCurrency(bill || null);
  }

  _formatUnsupportedForeignDocument(bill) {
    return {
      billId: bill._id?.toString?.() ?? bill._id,
      billNumber: bill.billNumber || null,
      documentCurrency: this._getDocumentCurrency(bill),
      baseCurrency: this._getDocumentBaseCurrency(bill),
    };
  }

  _buildForeignCurrencyBalanceWarnings(context, documents) {
    if (!documents.length) return [];

    return [{
      code: FOREIGN_CURRENCY_BALANCES_WARNING,
      message: `${context} excludes foreign-currency documents because base paid amounts and FX gain/loss handling are not supported in this version`,
      count: documents.length,
      documents,
    }];
  }
}

module.exports = new SupplierService();
