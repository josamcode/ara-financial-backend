'use strict';

const mongoose = require('mongoose');
const { Bill } = require('./bill.model');
const BillCounter = require('./billCounter.model');
const { Supplier } = require('../supplier/supplier.model');
const auditService = require('../audit/audit.service');
const { NotFoundError } = require('../../common/errors');
const logger = require('../../config/logger');

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

  async listBills(tenantId, { skip, limit, search, startDate, endDate } = {}) {
    const filter = { tenantId, deletedAt: null };
    const andFilters = [];

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
      .populate({ path: 'supplierId', select: 'name email phone', match: { tenantId } });

    if (!bill) throw new NotFoundError('Bill not found');
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
