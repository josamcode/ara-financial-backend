'use strict';

const mongoose = require('mongoose');
const { Bill } = require('./bill.model');
const BillCounter = require('./billCounter.model');
const { Supplier } = require('../supplier/supplier.model');
const journalService = require('../journal/journal.service');
const auditService = require('../audit/audit.service');
const { BadRequestError, NotFoundError } = require('../../common/errors');
const logger = require('../../config/logger');
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
    if (supplierId) {
      const supplier = await Supplier.findOne({ _id: supplierId, tenantId, deletedAt: null });
      if (supplier) {
        supplierName = supplier.name;
        supplierEmail = supplier.email || supplierEmail || '';
      }
    }

    const bill = await Bill.create({
      tenantId,
      billNumber,
      supplierId: supplierId || null,
      supplierName,
      supplierEmail: supplierEmail || '',
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
      action: 'bill.created',
      resourceType: 'Bill',
      resourceId: bill._id,
      newValues: { billNumber, supplierName: bill.supplierName },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, billId: bill._id, billNumber }, 'Bill created');
    return bill;
  }

  async listBills(tenantId, { skip, limit, status, search, startDate, endDate } = {}) {
    const filter = { tenantId, deletedAt: null };
    const andFilters = [];

    if (status) {
      const statusFilter = buildBillStatusFilter(status);
      if (statusFilter) {
        andFilters.push(statusFilter);
      }
    }

    if (startDate || endDate) {
      const issueDateFilter = {};
      if (startDate) issueDateFilter.$gte = new Date(startDate);
      if (endDate) issueDateFilter.$lte = new Date(endDate);
      andFilters.push({ issueDate: issueDateFilter });
    }

    if (search) {
      andFilters.push({
        $or: [
          { supplierName: { $regex: search, $options: 'i' } },
          { billNumber: { $regex: search, $options: 'i' } },
        ],
      });
    }

    if (andFilters.length > 0) {
      filter.$and = andFilters;
    }

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

  async postBill(billId, tenantId, userId, { apAccountId, debitAccountId }, options = {}) {
    const bill = await Bill.findOne({ _id: billId, tenantId });
    if (!bill) throw new NotFoundError('Bill not found');
    if (bill.status !== 'draft') {
      throw new BadRequestError('Only draft bills can be posted');
    }

    const totalStr = bill.total.toString();
    const postDescription = `Bill posted - ${bill.billNumber}`;

    const entry = await journalService.createEntry(
      tenantId,
      userId,
      {
        date: bill.issueDate.toISOString(),
        description: postDescription,
        reference: bill.billNumber,
        lines: [
          { accountId: debitAccountId, debit: totalStr, credit: '0' },
          { accountId: apAccountId, debit: '0', credit: totalStr },
        ].map((line) => ({ ...line, description: postDescription })),
      },
      { auditContext: options.auditContext }
    );

    await journalService.postEntry(entry._id, tenantId, userId, { auditContext: options.auditContext });

    bill.status = 'posted';
    bill.apAccountId = apAccountId;
    bill.paidAmount = 0;
    bill.remainingAmount = roundMonetaryAmount(Number(totalStr));
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

  async cancelBill(billId, tenantId, userId, options = {}) {
    const bill = await Bill.findOne({ _id: billId, tenantId });
    if (!bill) throw new NotFoundError('Bill not found');
    if (['paid', 'cancelled'].includes(bill.status)) {
      throw new BadRequestError('Paid or already cancelled bills cannot be cancelled');
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
      quantity: mongoose.Types.Decimal128.fromString(item.quantity),
      unitPrice: mongoose.Types.Decimal128.fromString(item.unitPrice),
      lineTotal: mongoose.Types.Decimal128.fromString(item.lineTotal),
    }));
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
