'use strict';

const Tenant = require('../tenant/tenant.model');
const currencyService = require('./currency.service');
const { BadRequestError, NotFoundError } = require('../../common/errors');
const {
  formatScaledInteger,
  toScaledInteger,
} = require('../../common/utils/money');

const EXCHANGE_RATE_SOURCES = Object.freeze([
  'manual',
  'api',
  'central_bank',
  'company_rate',
]);

const RATE_SCALE = 12;
const RATE_FACTOR = 10n ** BigInt(RATE_SCALE);
const RATE_PATTERN = /^\d+(\.\d{1,12})?$/;

function valueToString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value?.toString === 'function') return value.toString();
  return String(value);
}

function hasOwn(data, key) {
  return Boolean(data && Object.prototype.hasOwnProperty.call(data, key));
}

function hasValue(data, key) {
  return hasOwn(data, key) && valueToString(data[key]) !== '';
}

function invalidCurrencyError() {
  return new BadRequestError('Currency is invalid or inactive', 'INVALID_CURRENCY');
}

function normalizeCurrencyCode(value) {
  const normalized = valueToString(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw invalidCurrencyError();
  }

  return normalized;
}

function safeNormalizeCurrencyCode(value) {
  try {
    return value ? normalizeCurrencyCode(value) : null;
  } catch (_error) {
    return null;
  }
}

async function requireActiveCurrencyCode(code) {
  try {
    const currency = await currencyService.requireActiveCurrency(code);
    return currency.code;
  } catch (_error) {
    throw invalidCurrencyError();
  }
}

async function resolveTenantBaseCurrency(tenantId) {
  const tenant = await Tenant.findById(tenantId).select('baseCurrency').lean();
  if (!tenant) {
    throw new NotFoundError('Tenant not found');
  }

  return requireActiveCurrencyCode(tenant.baseCurrency || 'SAR');
}

function normalizeDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(`${label} must be a valid date`);
  }

  return date;
}

function normalizeExchangeRate(rate) {
  const normalized = valueToString(rate);
  if (!normalized) return null;

  if (!RATE_PATTERN.test(normalized) || /^0+(\.0+)?$/.test(normalized)) {
    throw new BadRequestError('Exchange rate must be greater than zero');
  }

  return normalized;
}

function toRateScaledInteger(rate) {
  const normalized = normalizeExchangeRate(rate);
  if (!normalized) {
    throw new BadRequestError('Exchange rate must be greater than zero');
  }

  const [intPart, fractionPart = ''] = normalized.split('.');
  const scaledFraction = fractionPart
    .padEnd(RATE_SCALE, '0')
    .substring(0, RATE_SCALE);

  return (BigInt(intPart || '0') * RATE_FACTOR) + BigInt(scaledFraction || '0');
}

function normalizeSource(value, fallback = 'manual') {
  const source = valueToString(value, fallback) || fallback;
  if (!EXCHANGE_RATE_SOURCES.includes(source)) {
    throw new BadRequestError('Exchange rate source is invalid');
  }

  return source;
}

function normalizeProvider(value) {
  const provider = valueToString(value);
  return provider || null;
}

function normalizeManualOverride(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  throw new BadRequestError('Manual exchange rate override must be a boolean');
}

function pickDocumentCurrency(data, existingDocument, baseCurrency) {
  if (hasValue(data, 'documentCurrency')) return data.documentCurrency;
  if (hasValue(data, 'currency')) return data.currency;
  if (existingDocument?.documentCurrency) return existingDocument.documentCurrency;
  if (existingDocument?.currency) return existingDocument.currency;
  return baseCurrency;
}

function hasExplicitCurrencyInput(data) {
  return hasValue(data, 'documentCurrency') || hasValue(data, 'currency');
}

function hasExistingSnapshot(existingDocument) {
  return Boolean(
    existingDocument?.documentCurrency &&
    existingDocument?.baseCurrency &&
    existingDocument?.exchangeRate &&
    existingDocument?.exchangeRateDate
  );
}

function pickExistingSnapshotRate(data, existingDocument, documentCurrency, baseCurrency) {
  if (!hasExistingSnapshot(existingDocument)) return undefined;

  const existingDocumentCurrency = safeNormalizeCurrencyCode(existingDocument.documentCurrency);
  const existingBaseCurrency = safeNormalizeCurrencyCode(existingDocument.baseCurrency);
  const currencyChanged = hasExplicitCurrencyInput(data) &&
    existingDocumentCurrency &&
    existingDocumentCurrency !== documentCurrency;

  if (
    currencyChanged ||
    existingDocumentCurrency !== documentCurrency ||
    existingBaseCurrency !== baseCurrency
  ) {
    return undefined;
  }

  return existingDocument.exchangeRate;
}

async function resolveDocumentCurrencySnapshot(tenantId, data, existingDocument = null) {
  const baseCurrency = await resolveTenantBaseCurrency(tenantId);
  const documentCurrency = await requireActiveCurrencyCode(
    normalizeCurrencyCode(pickDocumentCurrency(data, existingDocument, baseCurrency))
  );
  const issueDate = data.issueDate || existingDocument?.issueDate || new Date();

  if (documentCurrency === baseCurrency) {
    return {
      currency: documentCurrency,
      documentCurrency,
      baseCurrency,
      exchangeRate: '1',
      exchangeRateDate: normalizeDate(data.exchangeRateDate || issueDate, 'Exchange rate date'),
      exchangeRateSource: 'company_rate',
      exchangeRateProvider: null,
      isExchangeRateManualOverride: false,
    };
  }

  const existingRate = pickExistingSnapshotRate(
    data,
    existingDocument,
    documentCurrency,
    baseCurrency
  );
  const exchangeRate = normalizeExchangeRate(
    hasValue(data, 'exchangeRate') ? data.exchangeRate : existingRate
  );

  if (!exchangeRate) {
    throw new BadRequestError(
      'Exchange rate is required when document currency differs from base currency',
      'EXCHANGE_RATE_REQUIRED'
    );
  }

  const reuseExistingSnapshot = existingRate !== undefined && !hasValue(data, 'exchangeRate');
  const exchangeRateDate = normalizeDate(
    hasValue(data, 'exchangeRateDate')
      ? data.exchangeRateDate
      : reuseExistingSnapshot
        ? existingDocument.exchangeRateDate
        : issueDate,
    'Exchange rate date'
  );
  const exchangeRateSource = normalizeSource(
    hasValue(data, 'exchangeRateSource')
      ? data.exchangeRateSource
      : reuseExistingSnapshot
        ? existingDocument.exchangeRateSource
        : undefined,
    'manual'
  );
  const exchangeRateProvider = hasOwn(data, 'exchangeRateProvider')
    ? normalizeProvider(data.exchangeRateProvider)
    : reuseExistingSnapshot
      ? normalizeProvider(existingDocument.exchangeRateProvider)
      : null;
  const isExchangeRateManualOverride = hasOwn(data, 'isExchangeRateManualOverride')
    ? normalizeManualOverride(data.isExchangeRateManualOverride, exchangeRateSource === 'manual')
    : reuseExistingSnapshot
      ? Boolean(existingDocument.isExchangeRateManualOverride)
      : exchangeRateSource === 'manual';

  return {
    currency: documentCurrency,
    documentCurrency,
    baseCurrency,
    exchangeRate,
    exchangeRateDate,
    exchangeRateSource,
    exchangeRateProvider,
    isExchangeRateManualOverride,
  };
}

function multiplyMoneyByRate(amountScaled, rateScaled) {
  return ((amountScaled * rateScaled) + (RATE_FACTOR / 2n)) / RATE_FACTOR;
}

function formatBaseAmount(value) {
  return formatScaledInteger(value, 6)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

function convertMoneyToBaseScaled(amount, rateScaled) {
  return multiplyMoneyByRate(toScaledInteger(valueToString(amount, '0')), rateScaled);
}

function calculateBaseTotals(lineItems, exchangeRate) {
  const rateScaled = toRateScaledInteger(exchangeRate);
  let baseSubtotal = 0n;
  let baseTaxTotal = 0n;
  let baseTotal = 0n;

  const convertedLineItems = (lineItems || []).map((item) => {
    const lineBaseSubtotal = convertMoneyToBaseScaled(item.lineSubtotal || '0', rateScaled);
    const lineBaseTaxAmount = convertMoneyToBaseScaled(item.taxAmount || '0', rateScaled);
    const lineBaseTotal = convertMoneyToBaseScaled(item.lineTotal || '0', rateScaled);

    baseSubtotal += lineBaseSubtotal;
    baseTaxTotal += lineBaseTaxAmount;
    baseTotal += lineBaseTotal;

    return {
      ...item,
      lineBaseSubtotal: formatBaseAmount(lineBaseSubtotal),
      lineBaseTaxAmount: formatBaseAmount(lineBaseTaxAmount),
      lineBaseTotal: formatBaseAmount(lineBaseTotal),
    };
  });

  return {
    lineItems: convertedLineItems,
    baseSubtotal: formatBaseAmount(baseSubtotal),
    baseTaxTotal: formatBaseAmount(baseTaxTotal),
    baseTotal: formatBaseAmount(baseTotal),
  };
}

module.exports = {
  EXCHANGE_RATE_SOURCES,
  calculateBaseTotals,
  resolveDocumentCurrencySnapshot,
};
