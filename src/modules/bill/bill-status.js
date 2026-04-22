'use strict';

const PAYABLE_BILL_STATUSES = Object.freeze(['posted', 'partially_paid', 'overdue']);

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

function resolveBillTotalAmount(bill) {
  return roundMonetaryAmount(toNumericAmount(bill?.total));
}

function resolveBillPaidAmount(bill, totalAmount = resolveBillTotalAmount(bill)) {
  if (typeof bill?.paidAmount === 'number') {
    return roundMonetaryAmount(bill.paidAmount);
  }

  if (typeof bill?.remainingAmount === 'number') {
    return Math.max(0, roundMonetaryAmount(totalAmount - bill.remainingAmount));
  }

  return bill?.status === 'paid' ? totalAmount : 0;
}

function resolveBillRemainingAmount(
  bill,
  totalAmount = resolveBillTotalAmount(bill),
  paidAmount = resolveBillPaidAmount(bill, totalAmount)
) {
  if (typeof bill?.remainingAmount === 'number') {
    return Math.max(0, roundMonetaryAmount(bill.remainingAmount));
  }

  if (bill?.status === 'paid') {
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

function isBillOverdue(bill, { asOfDate = new Date() } = {}) {
  const remainingAmount = resolveBillRemainingAmount(bill);
  if (remainingAmount <= 0) {
    return false;
  }

  const dueDayValue = toUtcDayValue(bill?.dueDate);
  const asOfDayValue = toUtcDayValue(asOfDate);

  return dueDayValue !== null && asOfDayValue !== null && dueDayValue < asOfDayValue;
}

function resolveBillStatus(bill, options = {}) {
  const baseStatus = bill?.status;
  if (!baseStatus || !PAYABLE_BILL_STATUSES.includes(baseStatus)) {
    return baseStatus || 'draft';
  }

  const totalAmount = resolveBillTotalAmount(bill);
  const paidAmount = resolveBillPaidAmount(bill, totalAmount);
  const remainingAmount = resolveBillRemainingAmount(bill, totalAmount, paidAmount);

  if (remainingAmount <= 0) {
    return 'paid';
  }

  if (isBillOverdue({ ...bill, paidAmount, remainingAmount }, options)) {
    return 'overdue';
  }

  return paidAmount > 0 ? 'partially_paid' : 'posted';
}

function buildBillStatusFilter(status, { asOfDate = new Date() } = {}) {
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
            status: { $in: PAYABLE_BILL_STATUSES },
            remainingAmount: { $lte: 0 },
          },
        ],
      };
    case 'overdue':
      return {
        status: { $in: PAYABLE_BILL_STATUSES },
        remainingAmount: { $gt: 0 },
        dueDate: { $lt: asOfDayStart },
      };
    case 'partially_paid':
      return {
        status: { $in: PAYABLE_BILL_STATUSES },
        remainingAmount: { $gt: 0 },
        paidAmount: { $gt: 0 },
        dueDate: { $gte: asOfDayStart },
      };
    case 'posted':
      return {
        status: { $in: PAYABLE_BILL_STATUSES },
        remainingAmount: { $gt: 0 },
        paidAmount: { $lte: 0 },
        dueDate: { $gte: asOfDayStart },
      };
    default:
      return { status };
  }
}

module.exports = {
  buildBillStatusFilter,
  getUtcDayStart,
  PAYABLE_BILL_STATUSES,
  resolveBillPaidAmount,
  resolveBillRemainingAmount,
  resolveBillStatus,
  resolveBillTotalAmount,
  roundMonetaryAmount,
};
