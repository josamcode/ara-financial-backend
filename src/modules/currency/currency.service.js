'use strict';

const { Currency } = require('./currency.model');
const {
  BadRequestError,
  ConflictError,
  NotFoundError,
} = require('../../common/errors');

const DEFAULT_CURRENCIES = Object.freeze([
  {
    code: 'SAR',
    name: 'Saudi Riyal',
    symbol: '\u0631.\u0633',
    decimalPlaces: 2,
    isActive: true,
    isDefault: true,
    sortOrder: 10,
  },
  {
    code: 'USD',
    name: 'US Dollar',
    symbol: '$',
    decimalPlaces: 2,
    isActive: true,
    isDefault: false,
    sortOrder: 20,
  },
  {
    code: 'EGP',
    name: 'Egyptian Pound',
    symbol: 'E\u00a3',
    decimalPlaces: 2,
    isActive: true,
    isDefault: false,
    sortOrder: 30,
  },
  {
    code: 'EUR',
    name: 'Euro',
    symbol: '\u20ac',
    decimalPlaces: 2,
    isActive: true,
    isDefault: false,
    sortOrder: 40,
  },
]);

function normalizeCurrencyCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new BadRequestError('Currency code must be a 3-letter ISO code', 'INVALID_CURRENCY_CODE');
  }

  return normalized;
}

class CurrencyService {
  async listCurrencies({ isActive } = {}) {
    const filter = {};
    if (isActive !== undefined) {
      filter.isActive = isActive;
    }

    return Currency.find(filter).sort({ sortOrder: 1, code: 1 });
  }

  async getCurrencyByCode(code) {
    const normalizedCode = normalizeCurrencyCode(code);
    const currency = await Currency.findOne({ code: normalizedCode });
    if (!currency) {
      throw new NotFoundError('Currency not found', 'CURRENCY_NOT_FOUND');
    }

    return currency;
  }

  async requireActiveCurrency(code) {
    const currency = await this.getCurrencyByCode(code);
    if (!currency.isActive) {
      throw new BadRequestError('Currency is inactive', 'CURRENCY_INACTIVE');
    }

    return currency;
  }

  async createCurrency(data) {
    const code = normalizeCurrencyCode(data.code);
    const existing = await Currency.findOne({ code });
    if (existing) {
      throw new ConflictError(`Currency code "${code}" already exists`, 'CURRENCY_EXISTS');
    }

    const currency = await Currency.create({
      code,
      name: data.name,
      symbol: data.symbol,
      decimalPlaces: data.decimalPlaces ?? 2,
      isActive: data.isActive ?? true,
      isDefault: data.isDefault ?? false,
      sortOrder: data.sortOrder ?? 0,
    });

    if (currency.isDefault) {
      await this._clearOtherDefaults(currency.code);
    }

    return currency;
  }

  async updateCurrency(code, data) {
    const normalizedCode = normalizeCurrencyCode(code);
    const currency = await Currency.findOne({ code: normalizedCode });
    if (!currency) {
      throw new NotFoundError('Currency not found', 'CURRENCY_NOT_FOUND');
    }

    if (data.name !== undefined) currency.name = data.name;
    if (data.symbol !== undefined) currency.symbol = data.symbol;
    if (data.decimalPlaces !== undefined) currency.decimalPlaces = data.decimalPlaces;
    if (data.isActive !== undefined) currency.isActive = data.isActive;
    if (data.isDefault !== undefined) currency.isDefault = data.isDefault;
    if (data.sortOrder !== undefined) currency.sortOrder = data.sortOrder;

    await currency.save();

    if (currency.isDefault) {
      await this._clearOtherDefaults(currency.code);
    }

    return currency;
  }

  async seedDefaultCurrencies() {
    let inserted = 0;
    let matched = 0;
    let modified = 0;

    for (const defaultCurrency of DEFAULT_CURRENCIES) {
      const existing = await Currency.findOne({ code: defaultCurrency.code });
      if (!existing) {
        await Currency.create(defaultCurrency);
        inserted += 1;
        continue;
      }

      matched += 1;
      const missingFields = {};
      for (const field of ['name', 'symbol', 'decimalPlaces', 'isActive', 'sortOrder']) {
        if (existing[field] === undefined || existing[field] === null || existing[field] === '') {
          missingFields[field] = defaultCurrency[field];
        }
      }

      if (defaultCurrency.code === 'SAR' && existing.isDefault !== true) {
        missingFields.isDefault = true;
      } else if (defaultCurrency.code !== 'SAR' && existing.isDefault === undefined) {
        missingFields.isDefault = false;
      }

      if (Object.keys(missingFields).length > 0) {
        await Currency.updateOne({ _id: existing._id }, { $set: missingFields });
        modified += 1;
      }
    }

    const defaultCleanup = await Currency.updateMany(
      { code: { $ne: 'SAR' }, isDefault: true },
      { $set: { isDefault: false } }
    );
    modified += defaultCleanup.modifiedCount || 0;

    return {
      inserted,
      matched,
      modified,
      currencyCodes: DEFAULT_CURRENCIES.map((currency) => currency.code),
    };
  }

  normalizeCurrencyCode(code) {
    return normalizeCurrencyCode(code);
  }

  async _clearOtherDefaults(code) {
    await Currency.updateMany(
      { code: { $ne: code }, isDefault: true },
      { $set: { isDefault: false } }
    );
  }
}

module.exports = new CurrencyService();
module.exports.DEFAULT_CURRENCIES = DEFAULT_CURRENCIES;
module.exports.normalizeCurrencyCode = normalizeCurrencyCode;
