'use strict';

const mongoose = require('mongoose');
const { ExchangeRate } = require('./exchange-rate.model');
const currencyService = require('../currency/currency.service');
const {
  BadRequestError,
  NotFoundError,
} = require('../../common/errors');

function rateToDecimal128(rate) {
  return mongoose.Types.Decimal128.fromString(String(rate).trim());
}

function toDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError('Effective date must be a valid date');
  }

  return date;
}

function isRateOne(rate) {
  return String(rate).trim() === '1' || /^1\.0+$/.test(String(rate).trim());
}

class ExchangeRateService {
  async listExchangeRates(tenantId, {
    from,
    to,
    source,
    isActive,
    skip = 0,
    limit = 20,
  } = {}) {
    const filter = { tenantId };
    if (from) filter.fromCurrency = currencyService.normalizeCurrencyCode(from);
    if (to) filter.toCurrency = currencyService.normalizeCurrencyCode(to);
    if (source) filter.source = source;
    if (isActive !== undefined) filter.isActive = isActive;

    const [exchangeRates, total] = await Promise.all([
      ExchangeRate.find(filter)
        .sort({ effectiveDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit),
      ExchangeRate.countDocuments(filter),
    ]);

    return { exchangeRates, total };
  }

  async createExchangeRate(tenantId, userId, data) {
    const normalized = await this._normalizeAndValidatePayload(data);

    return ExchangeRate.create({
      tenantId,
      createdBy: userId,
      ...normalized,
    });
  }

  async getLatestExchangeRate(tenantId, { from, to, date }) {
    const fromCurrency = currencyService.normalizeCurrencyCode(from);
    const toCurrency = currencyService.normalizeCurrencyCode(to);

    await this._assertActiveCurrencies(fromCurrency, toCurrency);
    const effectiveDate = toDate(date);

    if (fromCurrency === toCurrency) {
      return {
        tenantId,
        fromCurrency,
        toCurrency,
        rate: '1',
        effectiveDate,
        source: 'company_rate',
        provider: null,
        isActive: true,
        isSynthetic: true,
      };
    }

    const exchangeRate = await ExchangeRate.findOne({
      tenantId,
      fromCurrency,
      toCurrency,
      isActive: true,
      effectiveDate: { $lte: effectiveDate },
    }).sort({ effectiveDate: -1, createdAt: -1 });

    if (!exchangeRate) {
      throw new NotFoundError('Exchange rate not found', 'EXCHANGE_RATE_NOT_FOUND');
    }

    return exchangeRate;
  }

  async updateExchangeRate(tenantId, exchangeRateId, data) {
    const exchangeRate = await ExchangeRate.findOne({ _id: exchangeRateId, tenantId });
    if (!exchangeRate) {
      throw new NotFoundError('Exchange rate not found', 'EXCHANGE_RATE_NOT_FOUND');
    }

    const payload = {
      fromCurrency: data.fromCurrency ?? exchangeRate.fromCurrency,
      toCurrency: data.toCurrency ?? exchangeRate.toCurrency,
      rate: data.rate ?? exchangeRate.rate.toString(),
      effectiveDate: data.effectiveDate ?? exchangeRate.effectiveDate,
      source: data.source ?? exchangeRate.source,
      provider: data.provider !== undefined ? data.provider : exchangeRate.provider,
      isActive: data.isActive !== undefined ? data.isActive : exchangeRate.isActive,
      notes: data.notes !== undefined ? data.notes : exchangeRate.notes,
    };
    const normalized = await this._normalizeAndValidatePayload(payload);

    exchangeRate.fromCurrency = normalized.fromCurrency;
    exchangeRate.toCurrency = normalized.toCurrency;
    exchangeRate.rate = normalized.rate;
    exchangeRate.effectiveDate = normalized.effectiveDate;
    exchangeRate.source = normalized.source;
    exchangeRate.provider = normalized.provider;
    exchangeRate.isActive = normalized.isActive;
    exchangeRate.notes = normalized.notes;

    await exchangeRate.save();
    return exchangeRate;
  }

  async deactivateExchangeRate(tenantId, exchangeRateId) {
    const exchangeRate = await ExchangeRate.findOneAndUpdate(
      { _id: exchangeRateId, tenantId },
      { $set: { isActive: false } },
      { returnDocument: 'after' }
    );

    if (!exchangeRate) {
      throw new NotFoundError('Exchange rate not found', 'EXCHANGE_RATE_NOT_FOUND');
    }

    return exchangeRate;
  }

  async _normalizeAndValidatePayload(data) {
    const fromCurrency = currencyService.normalizeCurrencyCode(data.fromCurrency);
    const toCurrency = currencyService.normalizeCurrencyCode(data.toCurrency);
    const rate = String(data.rate).trim();

    await this._assertActiveCurrencies(fromCurrency, toCurrency);
    if (fromCurrency === toCurrency && !isRateOne(rate)) {
      throw new BadRequestError(
        'Same-currency exchange rates must use rate 1',
        'INVALID_SAME_CURRENCY_RATE'
      );
    }

    return {
      fromCurrency,
      toCurrency,
      rate: rateToDecimal128(rate),
      effectiveDate: toDate(data.effectiveDate),
      source: data.source || 'manual',
      provider: data.provider || null,
      isActive: data.isActive !== undefined ? data.isActive : true,
      notes: data.notes || '',
    };
  }

  async _assertActiveCurrencies(fromCurrency, toCurrency) {
    await Promise.all([
      currencyService.requireActiveCurrency(fromCurrency),
      currencyService.requireActiveCurrency(toCurrency),
    ]);
  }
}

module.exports = new ExchangeRateService();
