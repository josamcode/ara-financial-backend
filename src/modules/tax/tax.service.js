'use strict';

const mongoose = require('mongoose');
const { TaxRate } = require('./tax-rate.model');
const { Account } = require('../account/account.model');
const {
  BadRequestError,
  ConflictError,
  NotFoundError,
} = require('../../common/errors');
const {
  MONEY_FACTOR,
  toScaledInteger,
  formatScaledInteger,
} = require('../../common/utils/money');

const TAX_ACCOUNT_ERROR_CODE = 'TAX_ACCOUNT_NOT_CONFIGURED';

function moneyToString(value, fallback = '0') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number') return String(value);
  if (typeof value?.toString === 'function') return value.toString();
  return String(value);
}

function parseScaled(value, label) {
  try {
    return toScaledInteger(moneyToString(value));
  } catch (_error) {
    throw new BadRequestError(`${label} must be a valid decimal amount`);
  }
}

function normalizeTaxAmount(value) {
  return formatScaledInteger(parseScaled(value, 'Tax amount'), 6);
}

function multiplyScaled(left, right) {
  return ((left * right) + (MONEY_FACTOR / 2n)) / MONEY_FACTOR;
}

function divideScaled(numerator, denominator) {
  return (numerator + (denominator / 2n)) / denominator;
}

function calculateLineTax({ quantity, unitPrice, discount = '0', taxRate = '0' }) {
  const quantityScaled = parseScaled(quantity, 'Line quantity');
  const unitPriceScaled = parseScaled(unitPrice, 'Line unit price');
  const discountScaled = parseScaled(discount, 'Line discount');
  const rateScaled = parseScaled(taxRate, 'Tax rate');

  if (quantityScaled <= 0n) {
    throw new BadRequestError('Line quantity must be greater than zero');
  }
  if (unitPriceScaled < 0n) {
    throw new BadRequestError('Line unit price cannot be negative');
  }
  if (discountScaled < 0n) {
    throw new BadRequestError('Line discount cannot be negative');
  }
  if (rateScaled < 0n || rateScaled > 100n * MONEY_FACTOR) {
    throw new BadRequestError('Tax rate must be between 0 and 100');
  }

  const grossSubtotal = multiplyScaled(quantityScaled, unitPriceScaled);
  const lineSubtotal = grossSubtotal - discountScaled;
  if (lineSubtotal < 0n) {
    throw new BadRequestError('Line discount cannot exceed line subtotal');
  }

  const taxAmount = divideScaled(lineSubtotal * rateScaled, 100n * MONEY_FACTOR);
  const lineTotal = lineSubtotal + taxAmount;

  return {
    lineSubtotal: formatScaledInteger(lineSubtotal, 6),
    taxRate: formatScaledInteger(rateScaled, 6),
    taxAmount: formatScaledInteger(taxAmount, 6),
    lineTotal: formatScaledInteger(lineTotal, 6),
  };
}

function calculateLinesTax(lines, taxRatesById = new Map()) {
  let subtotal = 0n;
  let taxTotal = 0n;
  let total = 0n;

  const lineItems = (lines || []).map((line) => {
    const taxRateId = normalizeOptionalObjectId(line.taxRateId);
    const taxRateDoc = taxRateId ? taxRatesById.get(taxRateId) : null;
    const taxRate = taxRateDoc ? taxRateDoc.rate.toString() : '0';
    const calculated = calculateLineTax({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discount: line.discount || '0',
      taxRate,
    });

    subtotal += toScaledInteger(calculated.lineSubtotal);
    taxTotal += toScaledInteger(calculated.taxAmount);
    total += toScaledInteger(calculated.lineTotal);

    return {
      ...line,
      taxRateId: taxRateId || null,
      taxRate: calculated.taxRate,
      taxAmount: calculated.taxAmount,
      lineSubtotal: calculated.lineSubtotal,
      lineTotal: calculated.lineTotal,
    };
  });

  return {
    lineItems,
    subtotal: formatScaledInteger(subtotal, 6),
    taxTotal: formatScaledInteger(taxTotal, 6),
    total: formatScaledInteger(total, 6),
  };
}

function normalizeOptionalObjectId(value) {
  const normalized = typeof value === 'string' ? value.trim() : value?.toString?.() ?? '';
  if (!normalized) return null;
  if (!mongoose.Types.ObjectId.isValid(normalized)) {
    throw new BadRequestError('Tax rate ID must be a valid ObjectId');
  }
  return normalized;
}

function normalizeCode(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.toUpperCase() : null;
}

function buildTaxAccountError(kind) {
  const label = kind === 'output' ? 'Output VAT liability' : 'Input VAT asset';
  return new BadRequestError(
    `${label} account is not configured. Create the VAT account before posting taxed documents.`,
    TAX_ACCOUNT_ERROR_CODE
  );
}

class TaxService {
  async listTaxRates(tenantId, { type, isActive, search, skip = 0, limit = 20 } = {}) {
    const filter = { tenantId };
    if (type) filter.type = type;
    if (isActive !== undefined) {
      filter.isActive = isActive;
    } else {
      filter.isActive = true;
    }
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }

    const [taxRates, total] = await Promise.all([
      TaxRate.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
      TaxRate.countDocuments(filter),
    ]);

    return { taxRates, total };
  }

  async getTaxRateById(taxRateId, tenantId) {
    const taxRate = await TaxRate.findOne({ _id: taxRateId, tenantId });
    if (!taxRate) throw new NotFoundError('Tax rate not found');
    return taxRate;
  }

  async createTaxRate(tenantId, userId, data) {
    const code = normalizeCode(data.code);
    if (code) {
      const existing = await TaxRate.findOne({ tenantId, code }).setOptions({ __includeDeleted: true });
      if (existing) {
        throw new ConflictError(`Tax rate code "${code}" already exists`);
      }
    }

    const taxRate = await TaxRate.create({
      tenantId,
      name: data.name,
      code,
      rate: mongoose.Types.Decimal128.fromString(moneyToString(data.rate)),
      type: data.type || 'both',
      isActive: data.isActive !== undefined ? data.isActive : true,
      description: data.description || '',
      createdBy: userId,
      updatedBy: userId,
    });

    return taxRate;
  }

  async updateTaxRate(taxRateId, tenantId, userId, data) {
    const taxRate = await TaxRate.findOne({ _id: taxRateId, tenantId });
    if (!taxRate) throw new NotFoundError('Tax rate not found');

    if (data.code !== undefined) {
      const code = normalizeCode(data.code);
      if (code) {
        const existing = await TaxRate.findOne({
          tenantId,
          code,
          _id: { $ne: taxRate._id },
        }).setOptions({ __includeDeleted: true });
        if (existing) {
          throw new ConflictError(`Tax rate code "${code}" already exists`);
        }
      }
      taxRate.code = code;
    }
    if (data.name !== undefined) taxRate.name = data.name;
    if (data.rate !== undefined) {
      taxRate.rate = mongoose.Types.Decimal128.fromString(moneyToString(data.rate));
    }
    if (data.type !== undefined) taxRate.type = data.type;
    if (data.isActive !== undefined) taxRate.isActive = data.isActive;
    if (data.description !== undefined) taxRate.description = data.description || '';
    taxRate.updatedBy = userId;

    await taxRate.save();
    return taxRate;
  }

  async deleteTaxRate(taxRateId, tenantId, userId) {
    const taxRate = await TaxRate.findOne({ _id: taxRateId, tenantId });
    if (!taxRate) throw new NotFoundError('Tax rate not found');
    taxRate.updatedBy = userId;
    await taxRate.softDelete();
    return taxRate;
  }

  async getTaxRatesForLines(tenantId, lines, allowedTypes) {
    const ids = [
      ...new Set((lines || [])
        .map((line) => normalizeOptionalObjectId(line.taxRateId))
        .filter(Boolean)),
    ];

    if (ids.length === 0) {
      return new Map();
    }

    const taxRates = await TaxRate.find({
      tenantId,
      _id: { $in: ids },
      isActive: true,
    });

    const taxRatesById = new Map(taxRates.map((taxRate) => [taxRate._id.toString(), taxRate]));
    for (const taxRateId of ids) {
      const taxRate = taxRatesById.get(taxRateId);
      if (!taxRate) {
        throw new BadRequestError('Tax rate not found or inactive');
      }
      if (!allowedTypes.includes(taxRate.type)) {
        throw new BadRequestError('Tax rate type is not valid for this document');
      }
    }

    return taxRatesById;
  }

  calculateLineTax(args) {
    return calculateLineTax(args);
  }

  calculateLinesTax(lines, taxRatesById) {
    return calculateLinesTax(lines, taxRatesById);
  }

  normalizeTaxAmount(value) {
    return normalizeTaxAmount(value);
  }

  async resolveOutputVatAccount(tenantId) {
    return this._resolveTaxAccount(tenantId, 'output');
  }

  async resolveInputVatAccount(tenantId) {
    return this._resolveTaxAccount(tenantId, 'input');
  }

  async _resolveTaxAccount(tenantId, kind) {
    const type = kind === 'output' ? 'liability' : 'asset';
    const nature = kind === 'output' ? 'credit' : 'debit';
    const namePatterns = kind === 'output'
      ? [/^VAT Payable$/i, /^Output VAT$/i, /^Output Tax$/i, /^Sales VAT$/i, /^Sales Tax Payable$/i]
      : [/^Input VAT$/i, /^VAT Receivable$/i, /^VAT Recoverable$/i, /^Input Tax$/i, /^Purchase VAT$/i];
    const codeCandidates = kind === 'output'
      ? ['2140', 'OUTPUT-VAT', 'VAT-OUTPUT', 'OUTPUT_TAX']
      : ['INPUT-VAT', 'VAT-INPUT', 'INPUT_TAX', 'VAT-REC'];

    const accounts = await Account.find({
      tenantId,
      type,
      nature,
      isActive: true,
      isParentOnly: false,
      $or: [
        { code: { $in: codeCandidates } },
        { nameEn: { $in: namePatterns } },
        { nameAr: { $in: namePatterns } },
      ],
    }).sort({ code: 1 });

    if (!accounts.length) {
      throw buildTaxAccountError(kind);
    }

    return accounts[0];
  }
}

module.exports = new TaxService();
module.exports.calculateLineTax = calculateLineTax;
module.exports.calculateLinesTax = calculateLinesTax;
module.exports.normalizeTaxAmount = normalizeTaxAmount;
module.exports.TAX_ACCOUNT_ERROR_CODE = TAX_ACCOUNT_ERROR_CODE;
