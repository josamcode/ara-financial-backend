'use strict';

const mongoose = require('mongoose');
const { Invoice } = require('./invoice.model');
const InvoiceCounter = require('./invoiceCounter.model');
const journalService = require('../journal/journal.service');
const auditService = require('../audit/audit.service');
const { BadRequestError, NotFoundError } = require('../../common/errors');
const logger = require('../../config/logger');

class InvoiceService {
  async createInvoice(tenantId, userId, data, options = {}) {
    const invoiceNumber = await this._getNextInvoiceNumber(tenantId);

    const invoice = await Invoice.create({
      tenantId,
      invoiceNumber,
      customerName: data.customerName,
      customerEmail: data.customerEmail || '',
      issueDate: new Date(data.issueDate),
      dueDate: new Date(data.dueDate),
      currency: data.currency || 'EGP',
      lineItems: this._buildLineItems(data.lineItems),
      subtotal: mongoose.Types.Decimal128.fromString(data.subtotal),
      total: mongoose.Types.Decimal128.fromString(data.total),
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

  async listInvoices(tenantId, { page, limit, skip, status, search, startDate, endDate }) {
    const filter = { tenantId, deletedAt: null };

    if (status) filter.status = status;
    if (startDate || endDate) {
      filter.issueDate = {};
      if (startDate) filter.issueDate.$gte = new Date(startDate);
      if (endDate) filter.issueDate.$lte = new Date(endDate);
    }
    if (search) {
      filter.$or = [
        { customerName: { $regex: search, $options: 'i' } },
        { invoiceNumber: { $regex: search, $options: 'i' } },
      ];
    }

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
      .populate({
        path: 'sentJournalEntryId',
        select: 'entryNumber date status',
        match: { tenantId },
      })
      .populate({
        path: 'paymentJournalEntryId',
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

    if (data.customerName !== undefined) invoice.customerName = data.customerName;
    if (data.customerEmail !== undefined) invoice.customerEmail = data.customerEmail;
    if (data.issueDate) invoice.issueDate = new Date(data.issueDate);
    if (data.dueDate) invoice.dueDate = new Date(data.dueDate);
    if (data.currency) invoice.currency = data.currency;
    if (data.notes !== undefined) invoice.notes = data.notes;
    if (data.lineItems) {
      invoice.lineItems = this._buildLineItems(data.lineItems);
    }
    if (data.subtotal) invoice.subtotal = mongoose.Types.Decimal128.fromString(data.subtotal);
    if (data.total) invoice.total = mongoose.Types.Decimal128.fromString(data.total);

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

    // Create journal entry (draft then post)
    const entry = await journalService.createEntry(
      tenantId,
      userId,
      {
        date: invoice.issueDate.toISOString(),
        description: `فاتورة رقم ${invoice.invoiceNumber} - ${invoice.customerName}`,
        reference: invoice.invoiceNumber,
        lines: [
          { accountId: arAccountId, debit: totalStr, credit: '0', description: 'ذمم مدينة' },
          { accountId: revenueAccountId, debit: '0', credit: totalStr, description: 'إيراد' },
        ],
      },
      { auditContext: options.auditContext }
    );

    await journalService.postEntry(entry._id, tenantId, userId, { auditContext: options.auditContext });

    invoice.status = 'sent';
    invoice.arAccountId = arAccountId;
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
  async recordPayment(invoiceId, tenantId, userId, { cashAccountId, paymentDate }, options = {}) {
    const invoice = await Invoice.findOne({ _id: invoiceId, tenantId });
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (!['sent', 'overdue'].includes(invoice.status)) {
      throw new BadRequestError('Only sent or overdue invoices can be marked as paid');
    }
    const totalStr = invoice.total.toString();
    const date = paymentDate ? new Date(paymentDate) : new Date();
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
        reference: invoice.invoiceNumber,
        lines: [
          { accountId: cashAccountId, debit: totalStr, credit: '0', description: 'تحصيل نقدي' },
          { accountId: arAccountId, debit: '0', credit: totalStr, description: 'ذمم مدينة' },
        ],
      },
      { auditContext: options.auditContext }
    );

    await journalService.postEntry(entry._id, tenantId, userId, { auditContext: options.auditContext });

    invoice.status = 'paid';
    invoice.paidAt = new Date();
    invoice.paymentJournalEntryId = entry._id;
    await invoice.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'invoice.paid',
      resourceType: 'Invoice',
      resourceId: invoice._id,
      newValues: { invoiceNumber: invoice.invoiceNumber, journalEntryId: entry._id },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, invoiceId, entryId: entry._id }, 'Invoice payment recorded');
    return invoice;
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
