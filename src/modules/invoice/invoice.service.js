'use strict';

const mongoose = require('mongoose');
const { Invoice } = require('./invoice.model');
const InvoiceCounter = require('./invoiceCounter.model');
const { Customer } = require('../customer/customer.model');
const journalService = require('../journal/journal.service');
const auditService = require('../audit/audit.service');
const { BadRequestError, NotFoundError } = require('../../common/errors');
const logger = require('../../config/logger');
const {
  buildInvoiceStatusFilter,
  COLLECTIBLE_INVOICE_STATUSES,
} = require('./invoice-status');

class InvoiceService {
  async createInvoice(tenantId, userId, data, options = {}) {
    const invoiceNumber = await this._getNextInvoiceNumber(tenantId);

    let { customerName, customerEmail, customerId } = data;
    if (customerId) {
      const customer = await Customer.findOne({ _id: customerId, tenantId, deletedAt: null });
      if (customer) {
        customerName = customer.name;
        customerEmail = customer.email || customerEmail || '';
      }
    }

    const invoice = await Invoice.create({
      tenantId,
      invoiceNumber,
      customerId: customerId || null,
      customerName,
      customerEmail: customerEmail || '',
      issueDate: new Date(data.issueDate),
      dueDate: new Date(data.dueDate),
      currency: data.currency || 'EGP',
      lineItems: this._buildLineItems(data.lineItems),
      subtotal: mongoose.Types.Decimal128.fromString(data.subtotal),
      total: mongoose.Types.Decimal128.fromString(data.total),
      paidAmount: 0,
      remainingAmount: Number(data.total),
      payments: [],
      notes: data.notes || '',
      status: 'draft',
      createdBy: userId,
    });

    await auditService.log({
      tenantId,
      userId,
      action: 'invoice.created',
      resourceType: 'Invoice',
      resourceId: invoice._id,
      newValues: { invoiceNumber, customerName: data.customerName },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, invoiceId: invoice._id, invoiceNumber }, 'Invoice created');
    return invoice;
  }

  async listInvoices(tenantId, { skip, limit, status, search, dateFrom, dateTo, minAmount, maxAmount }) {
    const filter = this._buildListFilter(tenantId, {
      status,
      search,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
    });

    const [invoices, total] = await Promise.all([
      Invoice.find(filter)
        .populate({ path: 'createdBy', select: 'name email', match: { tenantId } })
        .sort({ issueDate: -1, invoiceNumber: -1 })
        .skip(skip)
        .limit(limit),
      Invoice.countDocuments(filter),
    ]);

    return { invoices, total };
  }

  async getInvoiceById(invoiceId, tenantId) {
    const invoice = await Invoice.findOne({ _id: invoiceId, tenantId })
      .populate({ path: 'createdBy', select: 'name email', match: { tenantId } })
      .populate({ path: 'customerId', select: 'name email phone', match: { tenantId } })
      .populate({
        path: 'sentJournalEntryId',
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

    if (!invoice) throw new NotFoundError('Invoice not found');
    return invoice;
  }

  async updateInvoice(invoiceId, tenantId, userId, data, options = {}) {
    const invoice = await Invoice.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (invoice.status !== 'draft') {
      throw new BadRequestError('Only draft invoices can be edited');
    }

    if (data.customerId !== undefined) {
      if (data.customerId) {
        const customer = await Customer.findOne({ _id: data.customerId, tenantId, deletedAt: null });
        if (customer) {
          invoice.customerId = customer._id;
          invoice.customerName = customer.name;
          invoice.customerEmail = customer.email || invoice.customerEmail;
        }
      } else {
        invoice.customerId = null;
        if (data.customerName !== undefined) invoice.customerName = data.customerName;
        if (data.customerEmail !== undefined) invoice.customerEmail = data.customerEmail;
      }
    } else {
      if (data.customerName !== undefined) invoice.customerName = data.customerName;
      if (data.customerEmail !== undefined) invoice.customerEmail = data.customerEmail;
    }
    if (data.issueDate) invoice.issueDate = new Date(data.issueDate);
    if (data.dueDate) invoice.dueDate = new Date(data.dueDate);
    if (data.currency) invoice.currency = data.currency;
    if (data.notes !== undefined) invoice.notes = data.notes;
    if (data.lineItems) {
      invoice.lineItems = this._buildLineItems(data.lineItems);
    }
    if (data.subtotal) invoice.subtotal = mongoose.Types.Decimal128.fromString(data.subtotal);
    if (data.total) {
      invoice.total = mongoose.Types.Decimal128.fromString(data.total);
      invoice.paidAmount = 0;
      invoice.remainingAmount = Number(data.total);
    }

    await invoice.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'invoice.updated',
      resourceType: 'Invoice',
      resourceId: invoice._id,
      newValues: { invoiceNumber: invoice.invoiceNumber },
      auditContext: options.auditContext,
    });

    return invoice;
  }

  /**
   * Mark invoice as sent and create accounting entry:
   * Dr Accounts Receivable / Cr Revenue
   */
  async markAsSent(invoiceId, tenantId, userId, { arAccountId, revenueAccountId }, options = {}) {
    const invoice = await Invoice.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (invoice.status !== 'draft') {
      throw new BadRequestError('Only draft invoices can be marked as sent');
    }

    const totalStr = invoice.total.toString();
    const sendDescription = `إرسال فاتورة - ${invoice.invoiceNumber}`;

    // Create journal entry (draft then post)
    const entry = await journalService.createEntry(
      tenantId,
      userId,
      {
        date: invoice.issueDate.toISOString(),
        description: `فاتورة رقم ${invoice.invoiceNumber} - ${invoice.customerName}`,
        description: sendDescription,
        reference: invoice.invoiceNumber,
        lines: [
          { accountId: arAccountId, debit: totalStr, credit: '0', description: 'ذمم مدينة' },
          { accountId: revenueAccountId, debit: '0', credit: totalStr, description: 'إيراد' },
        ].map((line) => ({ ...line, description: sendDescription })),
      },
      { auditContext: options.auditContext }
    );

    await journalService.postEntry(entry._id, tenantId, userId, { auditContext: options.auditContext });

    invoice.status = 'sent';
    invoice.arAccountId = arAccountId;
    invoice.paidAmount = 0;
    invoice.remainingAmount = Number(totalStr);
    invoice.sentAt = new Date();
    invoice.sentJournalEntryId = entry._id;
    await invoice.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'invoice.sent',
      resourceType: 'Invoice',
      resourceId: invoice._id,
      newValues: { invoiceNumber: invoice.invoiceNumber, journalEntryId: entry._id },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, invoiceId, entryId: entry._id }, 'Invoice marked as sent');
    return invoice;
  }

  /**
   * Record payment and create accounting entry:
   * Dr Cash/Bank / Cr Accounts Receivable
   */
  async recordPayment(invoiceId, tenantId, userId, { cashAccountId, amount, paymentDate }, options = {}) {
    const invoice = await Invoice.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (!COLLECTIBLE_INVOICE_STATUSES.includes(invoice.status)) {
      throw new BadRequestError('Only sent, overdue, or partially paid invoices can be paid');
    }

    const totalAmount = this._roundMonetaryAmount(Number(invoice.total?.toString() ?? 0));
    const paidAmount = this._resolvePaidAmount(invoice, totalAmount);
    const remainingAmount = this._resolveRemainingAmount(invoice, totalAmount, paidAmount);
    const paymentAmount = this._roundMonetaryAmount(Number(amount));
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      throw new BadRequestError('Payment amount must be greater than zero');
    }
    if (paymentAmount > remainingAmount) {
      throw new BadRequestError('Payment amount cannot exceed remaining amount');
    }

    const amountStr = paymentAmount.toFixed(6).replace(/\.?0+$/, '');
    const date = paymentDate ? new Date(paymentDate) : new Date();
    const paymentDescription = `تحصيل فاتورة - ${invoice.invoiceNumber}`;
    const arAccountId = invoice.arAccountId?._id
      ? invoice.arAccountId._id.toString()
      : invoice.arAccountId?.toString();
    if (!arAccountId) {
      throw new BadRequestError('Invoice has no stored accounts receivable account');
    }

    const entry = await journalService.createEntry(
      tenantId,
      userId,
      {
        date: date.toISOString(),
        description: `تحصيل فاتورة رقم ${invoice.invoiceNumber} - ${invoice.customerName}`,
        description: paymentDescription,
        reference: invoice.invoiceNumber,
        lines: [
          { accountId: cashAccountId, debit: amountStr, credit: '0', description: 'تحصيل نقدي' },
          { accountId: arAccountId, debit: '0', credit: amountStr, description: 'ذمم مدينة' },
        ].map((line) => ({ ...line, description: paymentDescription })),
      },
      { auditContext: options.auditContext }
    );

    await journalService.postEntry(entry._id, tenantId, userId, { auditContext: options.auditContext });

    invoice.paidAmount = this._roundMonetaryAmount(paidAmount + paymentAmount);
    invoice.remainingAmount = this._roundMonetaryAmount(totalAmount - invoice.paidAmount);
    if (invoice.remainingAmount < 0) invoice.remainingAmount = 0;
    invoice.payments.push({
      amount: paymentAmount,
      date,
      accountId: cashAccountId,
      journalEntryId: entry._id,
    });
    invoice.status = invoice.remainingAmount === 0
      ? 'paid'
      : invoice.paidAmount > 0
        ? 'partially_paid'
        : 'sent';
    invoice.paidAt = invoice.remainingAmount === 0 ? new Date() : null;
    invoice.paymentJournalEntryId = entry._id;
    await invoice.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'invoice.paid',
      resourceType: 'Invoice',
      resourceId: invoice._id,
      newValues: { invoiceNumber: invoice.invoiceNumber, journalEntryId: entry._id, amount: paymentAmount },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, invoiceId, entryId: entry._id, amount: paymentAmount }, 'Invoice payment recorded');
    return invoice;
  }

  async bulkCancelInvoices(invoiceIds, tenantId, userId, options = {}) {
    const uniqueInvoiceIds = this._normalizeBulkIds(invoiceIds);
    const invoices = await Invoice.find({ _id: { $in: uniqueInvoiceIds }, tenantId });

    if (invoices.length !== uniqueInvoiceIds.length) {
      throw new NotFoundError('One or more invoices not found');
    }

    if (invoices.some((invoice) => ['paid', 'cancelled'].includes(invoice.status))) {
      throw new BadRequestError('One or more selected invoices cannot be cancelled');
    }

    for (const invoiceId of uniqueInvoiceIds) {
      await this.cancelInvoice(invoiceId, tenantId, userId, options);
    }

    return { count: uniqueInvoiceIds.length };
  }

  async cancelInvoice(invoiceId, tenantId, userId, options = {}) {
    const invoice = await Invoice.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (['paid', 'cancelled'].includes(invoice.status)) {
      throw new BadRequestError('Paid or already cancelled invoices cannot be cancelled');
    }

    invoice.status = 'cancelled';
    invoice.cancelledAt = new Date();
    await invoice.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'invoice.cancelled',
      resourceType: 'Invoice',
      resourceId: invoice._id,
      newValues: { invoiceNumber: invoice.invoiceNumber },
      auditContext: options.auditContext,
    });

    return invoice;
  }

  async bulkDeleteInvoices(invoiceIds, tenantId, userId, options = {}) {
    const uniqueInvoiceIds = this._normalizeBulkIds(invoiceIds);
    const invoices = await Invoice.find({ _id: { $in: uniqueInvoiceIds }, tenantId });

    if (invoices.length !== uniqueInvoiceIds.length) {
      throw new NotFoundError('One or more invoices not found');
    }

    if (invoices.some((invoice) => invoice.status !== 'draft')) {
      throw new BadRequestError('Only draft invoices can be deleted');
    }

    for (const invoiceId of uniqueInvoiceIds) {
      await this.deleteInvoice(invoiceId, tenantId, userId, options);
    }

    return { count: uniqueInvoiceIds.length };
  }

  async deleteInvoice(invoiceId, tenantId, userId, options = {}) {
    const invoice = await Invoice.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (invoice.status !== 'draft') {
      throw new BadRequestError('Only draft invoices can be deleted');
    }
    await invoice.softDelete();

    await auditService.log({
      tenantId,
      userId,
      action: 'invoice.deleted',
      resourceType: 'Invoice',
      resourceId: invoice._id,
      newValues: { invoiceNumber: invoice.invoiceNumber },
      auditContext: options.auditContext,
    });
  }

  _buildLineItems(items) {
    return items.map((item) => ({
      description: item.description,
      quantity: mongoose.Types.Decimal128.fromString(item.quantity),
      unitPrice: mongoose.Types.Decimal128.fromString(item.unitPrice),
      lineTotal: mongoose.Types.Decimal128.fromString(item.lineTotal),
    }));
  }

  _roundMonetaryAmount(value) {
    return Math.round((Number(value) + Number.EPSILON) * 1000000) / 1000000;
  }

  _resolvePaidAmount(invoice, totalAmount) {
    if (typeof invoice.paidAmount === 'number') return this._roundMonetaryAmount(invoice.paidAmount);
    return invoice.status === 'paid' ? totalAmount : 0;
  }

  _resolveRemainingAmount(invoice, totalAmount, paidAmount = this._resolvePaidAmount(invoice, totalAmount)) {
    if (typeof invoice.remainingAmount === 'number') {
      return this._roundMonetaryAmount(invoice.remainingAmount);
    }
    if (invoice.status === 'paid') return 0;
    return this._roundMonetaryAmount(totalAmount - paidAmount);
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
    return buildInvoiceStatusFilter(status);
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
        { customerName: regex },
        { invoiceNumber: regex },
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
      throw new BadRequestError('At least one invoice is required');
    }
    return uniqueIds;
  }

  async _getNextInvoiceNumber(tenantId) {
    const key = 'invoice';
    const counter = await InvoiceCounter.findOneAndUpdate(
      { tenantId, key },
      { $inc: { sequence: 1 } },
      { returnDocument: 'after' }
    );

    if (counter) {
      return `INV-${String(counter.sequence).padStart(4, '0')}`;
    }

    const last = await Invoice.findOne({ tenantId })
      .sort({ createdAt: -1 })
      .select('invoiceNumber')
      .setOptions({ __includeDeleted: true });

    const lastNum = last ? parseInt(last.invoiceNumber.replace('INV-', ''), 10) : 0;
    const initialSequence = (isNaN(lastNum) ? 0 : lastNum) + 1;

    try {
      const created = await InvoiceCounter.create({ tenantId, key, sequence: initialSequence });
      return `INV-${String(created.sequence).padStart(4, '0')}`;
    } catch (err) {
      if (err.code === 11000) {
        const retry = await InvoiceCounter.findOneAndUpdate(
          { tenantId, key },
          { $inc: { sequence: 1 } },
          { returnDocument: 'after' }
        );
        return `INV-${String(retry.sequence).padStart(4, '0')}`;
      }
      throw err;
    }
  }
}

module.exports = new InvoiceService();
