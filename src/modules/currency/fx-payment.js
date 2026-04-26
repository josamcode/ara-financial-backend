'use strict';

const { BadRequestError } = require('../../common/errors');
const {
  formatScaledInteger,
  toScaledInteger,
} = require('../../common/utils/money');

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

function formatMoney(value) {
  return formatScaledInteger(value, 6)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

function toRateScaledInteger(rate, label) {
  const normalized = valueToString(rate);
  if (!RATE_PATTERN.test(normalized) || /^0+(\.0+)?$/.test(normalized)) {
    throw new BadRequestError(`${label} must be greater than zero`);
  }

  const [intPart, fractionPart = ''] = normalized.split('.');
  const scaledFraction = fractionPart
    .padEnd(RATE_SCALE, '0')
    .substring(0, RATE_SCALE);

  return (BigInt(intPart || '0') * RATE_FACTOR) + BigInt(scaledFraction || '0');
}

function multiplyMoneyByRate(amountScaled, rateScaled) {
  return ((amountScaled * rateScaled) + (RATE_FACTOR / 2n)) / RATE_FACTOR;
}

function hasRemainingBaseAmount(value) {
  return value !== undefined && value !== null && valueToString(value) !== '';
}

/**
 * Calculates realized-FX payment amounts using integer money arithmetic.
 *
 * The returned fxGainLossType is invoice-style:
 * signedDifference > 0 means gain and signedDifference < 0 means loss.
 * Bill posting should invert that interpretation when Phase 6.2 adds journals.
 */
function calculateFxPayment({
  documentAmount,
  documentExchangeRate,
  paymentExchangeRate,
  isFinalPayment = false,
  remainingBaseAmount,
}) {
  const documentPaidScaled = toScaledInteger(valueToString(documentAmount, '0'));
  if (documentPaidScaled <= 0n) {
    throw new BadRequestError('Document payment amount must be greater than zero');
  }

  const documentRateScaled = toRateScaledInteger(
    documentExchangeRate,
    'Document exchange rate'
  );
  const paymentRateScaled = toRateScaledInteger(
    paymentExchangeRate,
    'Payment exchange rate'
  );
  const carryingBaseScaled = isFinalPayment && hasRemainingBaseAmount(remainingBaseAmount)
    ? toScaledInteger(valueToString(remainingBaseAmount, '0'))
    : multiplyMoneyByRate(documentPaidScaled, documentRateScaled);

  if (carryingBaseScaled < 0n) {
    throw new BadRequestError('Remaining base amount cannot be negative');
  }

  const paymentBaseScaled = multiplyMoneyByRate(documentPaidScaled, paymentRateScaled);
  const signedDifferenceScaled = paymentBaseScaled - carryingBaseScaled;
  const fxGainLossAmountScaled = signedDifferenceScaled < 0n
    ? -signedDifferenceScaled
    : signedDifferenceScaled;
  const fxGainLossType = signedDifferenceScaled > 0n
    ? 'gain'
    : signedDifferenceScaled < 0n
      ? 'loss'
      : 'none';

  return {
    documentPaidAmount: formatMoney(documentPaidScaled),
    carryingBaseAmount: formatMoney(carryingBaseScaled),
    paymentBaseAmount: formatMoney(paymentBaseScaled),
    signedDifference: formatMoney(signedDifferenceScaled),
    fxGainLossAmount: formatMoney(fxGainLossAmountScaled),
    fxGainLossType,
  };
}

module.exports = {
  calculateFxPayment,
};
