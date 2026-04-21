'use strict';

const { Customer } = require('./customer.model');
const { Invoice } = require('../invoice/invoice.model');
const { applyDerivedInvoiceStatus } = require('../invoice/invoice-status');
const auditService = require('../audit/audit.service');
const { NotFoundError } = require('../../common/errors');
const { buildPaginationMeta } = require('../../common/utils/response');

const INVOICED_STATUSES = ['sent', 'partially_paid', 'paid', 'overdue'];

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
    const derivedInvoices = invoices.map((invoice) => applyDerivedInvoiceStatus(invoice));

    let totalInvoiced = 0;
    let totalPaid = 0;
    let outstandingBalance = 0;

    for (const inv of derivedInvoices) {
      const amount = this._resolveInvoiceAmount(inv);
      if (!INVOICED_STATUSES.includes(inv.status)) continue;

      const paidAmount = this._resolveInvoicePaidAmount(inv, amount);
      const remainingAmount = this._resolveInvoiceRemainingAmount(inv, amount, paidAmount);

      totalInvoiced += amount;
      totalPaid += paidAmount;
      outstandingBalance += remainingAmount;
    }

    return {
      customer,
      invoices: derivedInvoices,
      summary: {
        totalInvoiced,
        totalPaid,
        outstandingBalance,
      },
    };
  }

  async getCustomerStatement(customerId, tenantId, { page = 1, limit = 20 } = {}) {
    const customer = await Customer.findOne({ _id: customerId, tenantId, deletedAt: null }).lean();
    if (!customer) throw new NotFoundError('Customer not found');

    const invoices = await Invoice.find({ customerId, tenantId, deletedAt: null })
      .sort({ issueDate: 1, invoiceNumber: 1 })
      .lean();
    const derivedInvoices = invoices.map((invoice) => applyDerivedInvoiceStatus(invoice));

    let totalInvoiced = 0;
    let totalPaid = 0;
    let outstandingBalance = 0;
    const entries = [];

    for (const invoice of derivedInvoices) {
      if (!INVOICED_STATUSES.includes(invoice.status)) continue;

      const amount = this._resolveInvoiceAmount(invoice);
      const paidAmount = this._resolveInvoicePaidAmount(invoice, amount);
      const remainingAmount = this._resolveInvoiceRemainingAmount(invoice, amount, paidAmount);

      totalInvoiced = this._roundAmount(totalInvoiced + amount);
      totalPaid = this._roundAmount(totalPaid + paidAmount);
      outstandingBalance = this._roundAmount(outstandingBalance + remainingAmount);

      entries.push({
        type: 'invoice',
        date: invoice.issueDate,
        reference: invoice.invoiceNumber,
        invoiceNumber: invoice.invoiceNumber,
        debit: amount,
        credit: 0,
        invoiceId: invoice._id,
        journalEntryId: invoice.sentJournalEntryId || null,
        currency: invoice.currency || 'EGP',
        _sortDate: new Date(invoice.issueDate).getTime(),
        _sortPriority: 0,
        _sortKey: `${invoice.invoiceNumber}:${invoice._id}`,
      });

      const payments = Array.isArray(invoice.payments) ? [...invoice.payments] : [];
      payments
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .forEach((payment, index) => {
          const paymentAmount = this._roundAmount(Number(payment.amount ?? 0));
          if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) return;

          entries.push({
            type: 'payment',
            date: payment.date,
            reference: invoice.invoiceNumber,
            invoiceNumber: invoice.invoiceNumber,
            debit: 0,
            credit: paymentAmount,
            invoiceId: invoice._id,
            journalEntryId: payment.journalEntryId || null,
            currency: invoice.currency || 'EGP',
            _sortDate: new Date(payment.date).getTime(),
            _sortPriority: 1,
            _sortKey: `${invoice.invoiceNumber}:${index}`,
          });
        });
    }

    entries.sort((a, b) => (
      a._sortDate - b._sortDate
      || a._sortPriority - b._sortPriority
      || String(a._sortKey).localeCompare(String(b._sortKey))
    ));

    let runningBalance = 0;
    const transactions = entries.map(({ _sortDate, _sortPriority, _sortKey, ...entry }) => {
      runningBalance = this._roundAmount(runningBalance + entry.debit - entry.credit);

      return {
        ...entry,
        invoiceId: entry.invoiceId?.toString?.() ?? entry.invoiceId,
        journalEntryId: entry.journalEntryId?.toString?.() ?? null,
        runningBalance,
      };
    });

    const pagination = buildPaginationMeta(page, limit, transactions.length);
    const paginatedTransactions = transactions.slice((page - 1) * limit, page * limit);

    return {
      customer,
      summary: {
        totalInvoiced,
        totalPaid,
        outstandingBalance,
      },
      transactions: paginatedTransactions,
      pagination,
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

  _roundAmount(value) {
    return Math.round((Number(value) + Number.EPSILON) * 1000000) / 1000000;
  }

  _resolveInvoiceAmount(invoice) {
    return this._roundAmount(parseFloat(invoice.total?.toString() ?? '0'));
  }

  _resolveInvoicePaidAmount(invoice, amount = this._resolveInvoiceAmount(invoice)) {
    if (typeof invoice.paidAmount === 'number') {
      return this._roundAmount(invoice.paidAmount);
    }

    return invoice.status === 'paid' ? amount : 0;
  }

  _resolveInvoiceRemainingAmount(
    invoice,
    amount = this._resolveInvoiceAmount(invoice),
    paidAmount = this._resolveInvoicePaidAmount(invoice, amount)
  ) {
    if (typeof invoice.remainingAmount === 'number') {
      return this._roundAmount(invoice.remainingAmount);
    }

    if (invoice.status === 'paid') return 0;
    return this._roundAmount(amount - paidAmount);
  }
}

module.exports = new CustomerService();
