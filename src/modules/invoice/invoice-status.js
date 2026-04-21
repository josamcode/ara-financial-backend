'use strict';

const COLLECTIBLE_INVOICE_STATUSES = Object.freeze(['sent', 'partially_paid', 'overdue']);

function roundMonetaryAmount(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000000) / 1000000;
}

function toNumericAmount(value) {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return Number(value);
  }

  if (value && typeof value.toString === 'function') {
    return Number(value.toString());
  }

  return 0;
}

function resolveInvoiceTotalAmount(invoice) {
  return roundMonetaryAmount(toNumericAmount(invoice?.total));
}

function resolveInvoicePaidAmount(invoice, totalAmount = resolveInvoiceTotalAmount(invoice)) {
  if (typeof invoice?.paidAmount === 'number') {
    return roundMonetaryAmount(invoice.paidAmount);
  }

  if (typeof invoice?.remainingAmount === 'number') {
    return Math.max(0, roundMonetaryAmount(totalAmount - invoice.remainingAmount));
  }

  return invoice?.status === 'paid' ? totalAmount : 0;
}

function resolveInvoiceRemainingAmount(
  invoice,
  totalAmount = resolveInvoiceTotalAmount(invoice),
  paidAmount = resolveInvoicePaidAmount(invoice, totalAmount)
) {
  if (typeof invoice?.remainingAmount === 'number') {
    return Math.max(0, roundMonetaryAmount(invoice.remainingAmount));
  }

  if (invoice?.status === 'paid') {
    return 0;
  }

  return Math.max(0, roundMonetaryAmount(totalAmount - paidAmount));
}

function toUtcDayValue(dateValue) {
  if (!dateValue) {
    return null;
  }

  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function getUtcDayStart(dateValue) {
  const dayValue = toUtcDayValue(dateValue);
  return dayValue === null ? null : new Date(dayValue);
}

function isInvoiceOverdue(invoice, { asOfDate = new Date() } = {}) {
  const remainingAmount = resolveInvoiceRemainingAmount(invoice);
  if (remainingAmount <= 0) {
    return false;
  }

  const dueDayValue = toUtcDayValue(invoice?.dueDate);
  const asOfDayValue = toUtcDayValue(asOfDate);

  return dueDayValue !== null && asOfDayValue !== null && dueDayValue < asOfDayValue;
}

function resolveInvoiceStatus(invoice, options = {}) {
  const baseStatus = invoice?.status;
  if (!baseStatus || !COLLECTIBLE_INVOICE_STATUSES.includes(baseStatus)) {
    return baseStatus || 'draft';
  }

  const totalAmount = resolveInvoiceTotalAmount(invoice);
  const paidAmount = resolveInvoicePaidAmount(invoice, totalAmount);
  const remainingAmount = resolveInvoiceRemainingAmount(invoice, totalAmount, paidAmount);

  if (remainingAmount <= 0) {
    return 'paid';
  }

  if (isInvoiceOverdue({ ...invoice, paidAmount, remainingAmount }, options)) {
    return 'overdue';
  }

  return paidAmount > 0 ? 'partially_paid' : 'sent';
}

function applyDerivedInvoiceStatus(invoice, options = {}) {
  if (!invoice || typeof invoice !== 'object') {
    return invoice;
  }

  invoice.status = resolveInvoiceStatus(invoice, options);
  return invoice;
}

function buildInvoiceStatusFilter(status, { asOfDate = new Date() } = {}) {
  if (!status) {
    return null;
  }

  const asOfDayStart = getUtcDayStart(asOfDate);

  switch (status) {
    case 'draft':
    case 'cancelled':
      return { status };
    case 'paid':
      return {
        $or: [
          { status: 'paid' },
          {
            status: { $in: COLLECTIBLE_INVOICE_STATUSES },
            remainingAmount: { $lte: 0 },
          },
        ],
      };
    case 'overdue':
      return {
        status: { $in: COLLECTIBLE_INVOICE_STATUSES },
        remainingAmount: { $gt: 0 },
        dueDate: { $lt: asOfDayStart },
      };
    case 'partially_paid':
      return {
        status: { $in: COLLECTIBLE_INVOICE_STATUSES },
        remainingAmount: { $gt: 0 },
        paidAmount: { $gt: 0 },
        dueDate: { $gte: asOfDayStart },
      };
    case 'sent':
      return {
        status: { $in: COLLECTIBLE_INVOICE_STATUSES },
        remainingAmount: { $gt: 0 },
        paidAmount: { $lte: 0 },
        dueDate: { $gte: asOfDayStart },
      };
    default:
      return { status };
  }
}

module.exports = {
  COLLECTIBLE_INVOICE_STATUSES,
  applyDerivedInvoiceStatus,
  buildInvoiceStatusFilter,
  getUtcDayStart,
  isInvoiceOverdue,
  resolveInvoicePaidAmount,
  resolveInvoiceRemainingAmount,
  resolveInvoiceStatus,
  resolveInvoiceTotalAmount,
  roundMonetaryAmount,
};
