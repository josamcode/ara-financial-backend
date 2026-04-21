'use strict';

const { Customer } = require('./customer.model');
const { Invoice } = require('../invoice/invoice.model');
const auditService = require('../audit/audit.service');
const { NotFoundError } = require('../../common/errors');

class CustomerService {
  async listCustomers(tenantId, { page = 1, limit = 20, skip = 0, search } = {}) {
    const filter = { tenantId, deletedAt: null };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const [customers, total] = await Promise.all([
      Customer.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
      Customer.countDocuments(filter),
    ]);

    return { customers, total };
  }

  async getCustomerById(customerId, tenantId) {
    const customer = await Customer.findOne({ _id: customerId, tenantId, deletedAt: null });
    if (!customer) throw new NotFoundError('Customer not found');
    return customer;
  }

  async getCustomerInvoices(customerId, tenantId) {
    const customer = await Customer.findOne({ _id: customerId, tenantId, deletedAt: null });
    if (!customer) throw new NotFoundError('Customer not found');

    const invoices = await Invoice.find({ customerId, tenantId, deletedAt: null })
      .sort({ issueDate: -1 })
      .lean();

    const INVOICED_STATUSES = ['sent', 'paid', 'overdue'];
    let totalInvoiced = 0;
    let totalPaid = 0;

    for (const inv of invoices) {
      const amount = parseFloat(inv.total?.toString() ?? '0');
      if (INVOICED_STATUSES.includes(inv.status)) totalInvoiced += amount;
      if (inv.status === 'paid') totalPaid += amount;
    }

    return {
      customer,
      invoices,
      summary: {
        totalInvoiced,
        totalPaid,
        outstandingBalance: totalInvoiced - totalPaid,
      },
    };
  }

  async createCustomer(tenantId, userId, data, options = {}) {
    const customer = await Customer.create({
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
      action: 'customer.created',
      resourceType: 'Customer',
      resourceId: customer._id,
      newValues: { name: customer.name },
      auditContext: options.auditContext,
    });

    return customer;
  }

  async updateCustomer(customerId, tenantId, userId, data, options = {}) {
    const customer = await Customer.findOne({ _id: customerId, tenantId, deletedAt: null });
    if (!customer) throw new NotFoundError('Customer not found');

    if (data.name !== undefined) customer.name = data.name;
    if (data.email !== undefined) customer.email = data.email;
    if (data.phone !== undefined) customer.phone = data.phone;
    if (data.address !== undefined) customer.address = data.address;
    if (data.notes !== undefined) customer.notes = data.notes;

    await customer.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'customer.updated',
      resourceType: 'Customer',
      resourceId: customer._id,
      newValues: { name: customer.name },
      auditContext: options.auditContext,
    });

    return customer;
  }

  async deleteCustomer(customerId, tenantId, userId, options = {}) {
    const customer = await Customer.findOne({ _id: customerId, tenantId, deletedAt: null });
    if (!customer) throw new NotFoundError('Customer not found');

    await customer.softDelete();

    await auditService.log({
      tenantId,
      userId,
      action: 'customer.deleted',
      resourceType: 'Customer',
      resourceId: customer._id,
      newValues: { name: customer.name },
      auditContext: options.auditContext,
    });
  }
}

module.exports = new CustomerService();
