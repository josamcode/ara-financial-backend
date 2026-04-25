'use strict';

const mongoose = require('mongoose');
const { Invoice } = require('./invoice.model');
const InvoiceCounter = require('./invoiceCounter.model');
const { Customer } = require('../customer/customer.model');
const Tenant = require('../tenant/tenant.model');
const journalService = require('../journal/journal.service');
const auditService = require('../audit/audit.service');
const billingLimitsService = require('../billing/billing-limits.service');
const { sendEmail } = require('../../common/utils/email');
const { buildInvoiceEmail } = require('./invoiceEmailTemplate');
const { BadRequestError, NotFoundError } = require('../../common/errors');
const logger = require('../../config/logger');
const { MONEY_FACTOR, toScaledInteger } = require('../../common/utils/money');
const {
  buildInvoiceStatusFilter,
  COLLECTIBLE_INVOICE_STATUSES,
} = require('./invoice-status');

class InvoiceService {
  async createInvoice(tenantId, userId, data, options = {}) {
    await billingLimitsService.assertMonthlyInvoiceLimit(tenantId);

    const invoiceNumber = await this._getNextInvoiceNumber(tenantId);

    let { customerName, customerEmail, customerId } = data;
    const customer = await this._resolveCustomer(tenantId, customerId);
    if (customer) {
      customerId = customer._id.toString();
      customerName = customer.name;
      customerEmail = customer.email || customerEmail || '';
    }

    const draftInvoice = this._normalizeDraftInvoiceInput({
      customerId,
      customerName,
      customerEmail,
      issueDate: data.issueDate,
      dueDate: data.dueDate,
      currency: data.currency,
      lineItems: data.lineItems,
      subtotal: data.subtotal,
      total: data.total,
      notes: data.notes,
    });
    this._assertValidDraftInvoice(draftInvoice);

    const invoice = await Invoice.create({
      tenantId,
      invoiceNumber,
      customerId: draftInvoice.customerId || null,
      customerName: draftInvoice.customerName,
      customerEmail: draftInvoice.customerEmail,
      issueDate: draftInvoice.issueDate,
      dueDate: draftInvoice.dueDate,
      currency: draftInvoice.currency,
      lineItems: this._buildLineItems(draftInvoice.lineItems),
      subtotal: mongoose.Types.Decimal128.fromString(draftInvoice.subtotal),
      total: mongoose.Types.Decimal128.fromString(draftInvoice.total),
      paidAmount: 0,
      remainingAmount: Number(draftInvoice.total),
      payments: [],
      notes: draftInvoice.notes,
      status: 'draft',
      createdBy: userId,
    });

    await auditService.log({
      tenantId,
      userId,
      action: 'invoice.created',
      resourceType: 'Invoice',
      resourceId: invoice._id,
      newValues: { invoiceNumber, customerName: draftInvoice.customerName },
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

  async exportInvoices(tenantId, { status, search, dateFrom, dateTo, minAmount, maxAmount } = {}) {
    const filter = this._buildListFilter(tenantId, {
      status,
      search,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
    });

    return Invoice.find(filter)
      .select('invoiceNumber customerName status total paidAmount remainingAmount issueDate dueDate')
      .sort({ issueDate: -1, invoiceNumber: -1 })
      .lean();
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

    let customerId = invoice.customerId ? invoice.customerId.toString() : null;
    let customerName = invoice.customerName;
    let customerEmail = invoice.customerEmail || '';

    if (data.customerId !== undefined) {
      if (data.customerId) {
        const customer = await this._resolveCustomer(tenantId, data.customerId);
        customerId = customer._id.toString();
        customerName = customer.name;
        customerEmail = customer.email || customerEmail;
      } else {
        customerId = null;
        if (data.customerName !== undefined) customerName = data.customerName;
        if (data.customerEmail !== undefined) customerEmail = data.customerEmail;
      }
    } else {
      if (data.customerName !== undefined) customerName = data.customerName;
      if (data.customerEmail !== undefined) customerEmail = data.customerEmail;
    }

    const draftInvoice = this._normalizeDraftInvoiceInput({
      customerId,
      customerName,
      customerEmail,
      issueDate: data.issueDate ?? invoice.issueDate,
      dueDate: data.dueDate ?? invoice.dueDate,
      currency: data.currency ?? invoice.currency,
      lineItems: data.lineItems ?? this._serializeLineItems(invoice.lineItems),
      subtotal: data.subtotal ?? invoice.subtotal,
      total: data.total ?? invoice.total,
      notes: data.notes !== undefined ? data.notes : invoice.notes,
    });
    this._assertValidDraftInvoice(draftInvoice);

    invoice.customerId = draftInvoice.customerId || null;
    invoice.customerName = draftInvoice.customerName;
    invoice.customerEmail = draftInvoice.customerEmail;
    invoice.issueDate = draftInvoice.issueDate;
    invoice.dueDate = draftInvoice.dueDate;
    invoice.currency = draftInvoice.currency;
    invoice.notes = draftInvoice.notes;
    invoice.lineItems = this._buildLineItems(draftInvoice.lineItems);
    invoice.subtotal = mongoose.Types.Decimal128.fromString(draftInvoice.subtotal);
    invoice.total = mongoose.Types.Decimal128.fromString(draftInvoice.total);
    invoice.paidAmount = 0;
    invoice.remainingAmount = Number(draftInvoice.total);

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

    this._assertValidDraftInvoice(this._normalizeDraftInvoiceInput({
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      customerEmail: invoice.customerEmail,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      lineItems: this._serializeLineItems(invoice.lineItems),
      subtotal: invoice.subtotal,
      total: invoice.total,
      notes: invoice.notes,
    }));

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
    if (remainingAmount <= 0) {
      throw new BadRequestError('Invoice has no remaining amount to pay');
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

    if (invoices.some((invoice) => !this._canCancelInvoice(invoice))) {
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
    if (invoice.status === 'cancelled') {
      throw new BadRequestError('Invoice is already cancelled');
    }
    if (invoice.status === 'paid') {
      throw new BadRequestError('Paid invoices cannot be cancelled');
    }
    if (!this._canCancelInvoice(invoice)) {
      throw new BadRequestError('Invoices with recorded payments cannot be cancelled');
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
      quantity: mongoose.Types.Decimal128.fromString(this._moneyToString(item.quantity)),
      unitPrice: mongoose.Types.Decimal128.fromString(this._moneyToString(item.unitPrice)),
      lineTotal: mongoose.Types.Decimal128.fromString(this._moneyToString(item.lineTotal)),
    }));
  }

  _serializeLineItems(items) {
    return (items || []).map((item) => ({
      description: item.description,
      quantity: this._moneyToString(item.quantity),
      unitPrice: this._moneyToString(item.unitPrice),
      lineTotal: this._moneyToString(item.lineTotal),
    }));
  }

  _normalizeDraftInvoiceInput(data) {
    return {
      customerId: this._normalizeOptionalObjectId(data.customerId, 'Customer ID'),
      customerName: data.customerName,
      customerEmail: data.customerEmail || '',
      issueDate: data.issueDate instanceof Date ? data.issueDate : new Date(data.issueDate),
      dueDate: data.dueDate instanceof Date ? data.dueDate : new Date(data.dueDate),
      currency: data.currency || 'EGP',
      lineItems: Array.isArray(data.lineItems)
        ? data.lineItems.map((item) => ({
          description: item.description,
          quantity: this._moneyToString(item.quantity),
          unitPrice: this._moneyToString(item.unitPrice),
          lineTotal: this._moneyToString(item.lineTotal),
        }))
        : [],
      subtotal: this._moneyToString(data.subtotal),
      total: this._moneyToString(data.total),
      notes: data.notes || '',
    };
  }

  _assertValidDraftInvoice(invoice) {
    if (!Array.isArray(invoice.lineItems) || invoice.lineItems.length === 0) {
      throw new BadRequestError('Invoice must contain at least one line item');
    }

    const subtotal = this._parseMoney(invoice.subtotal, 'Invoice subtotal');
    const total = this._parseMoney(invoice.total, 'Invoice total');
    let subtotalFromLines = 0n;

    invoice.lineItems.forEach((item, index) => {
      const lineNumber = index + 1;
      const quantity = this._parseMoney(item.quantity, `Invoice line ${lineNumber} quantity`);
      const unitPrice = this._parseMoney(item.unitPrice, `Invoice line ${lineNumber} unit price`);
      const lineTotal = this._parseMoney(item.lineTotal, `Invoice line ${lineNumber} line total`);

      if (quantity <= 0n) {
        throw new BadRequestError(`Invoice line ${lineNumber} quantity must be greater than zero`);
      }
      if (unitPrice < 0n) {
        throw new BadRequestError(`Invoice line ${lineNumber} unit price cannot be negative`);
      }
      if (lineTotal < 0n) {
        throw new BadRequestError(`Invoice line ${lineNumber} line total cannot be negative`);
      }

      const expectedLineTotal = ((quantity * unitPrice) + (MONEY_FACTOR / 2n)) / MONEY_FACTOR;
      if (lineTotal !== expectedLineTotal) {
        throw new BadRequestError(
          `Invoice line ${lineNumber} line total must equal quantity x unit price`
        );
      }

      subtotalFromLines += lineTotal;
    });

    if (subtotal <= 0n) {
      throw new BadRequestError('Invoice subtotal must be greater than zero');
    }
    if (total <= 0n) {
      throw new BadRequestError('Invoice total must be greater than zero');
    }
    if (subtotal !== subtotalFromLines) {
      throw new BadRequestError('Invoice subtotal must equal the sum of line totals');
    }
    if (total !== subtotal) {
      throw new BadRequestError('Invoice total must equal subtotal');
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

  async _resolveCustomer(tenantId, customerId) {
    const normalizedCustomerId = this._normalizeOptionalObjectId(customerId, 'Customer ID');
    if (!normalizedCustomerId) {
      return null;
    }

    const customer = await Customer.findOne({
      _id: normalizedCustomerId,
      tenantId,
      deletedAt: null,
    });

    if (!customer) {
      throw new NotFoundError('Customer not found');
    }

    return customer;
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

  _canCancelInvoice(invoice) {
    if (!invoice || ['paid', 'cancelled', 'partially_paid'].includes(invoice.status)) {
      return false;
    }

    const totalAmount = this._roundMonetaryAmount(Number(invoice.total?.toString() ?? 0));
    const paidAmount = this._resolvePaidAmount(invoice, totalAmount);
    const hasPayments = Array.isArray(invoice.payments) && invoice.payments.length > 0;

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

  async emailInvoice(invoiceId, tenantId, userId, options = {}) {
    const invoice = await Invoice.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new NotFoundError('Invoice not found');

    const email = invoice.customerEmail?.trim();
    if (!email) {
      throw new BadRequestError('Customer email is missing', 'CUSTOMER_EMAIL_MISSING');
    }

    const tenant = await Tenant.findById(tenantId).lean();
    const companyName = tenant?.name || 'ARA Financial';

    const { subject, html } = buildInvoiceEmail({ invoice, companyName });

    await sendEmail({ to: email, subject, html });

    invoice.lastEmailSentAt = new Date();
    invoice.emailSentCount = (invoice.emailSentCount || 0) + 1;
    await invoice.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'invoice.email_sent',
      resourceType: 'Invoice',
      resourceId: invoice._id,
      newValues: { sentTo: email, sentAt: invoice.lastEmailSentAt },
      auditContext: options.auditContext,
    });

    return invoice;
  }
}

module.exports = new InvoiceService();
