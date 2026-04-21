'use strict';

const { Supplier } = require('./supplier.model');
const auditService = require('../audit/audit.service');
const { NotFoundError } = require('../../common/errors');

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
}

module.exports = new SupplierService();
