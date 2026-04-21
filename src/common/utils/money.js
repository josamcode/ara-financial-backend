'use strict';

const MONEY_SCALE = 6;
const MONEY_FACTOR = 10n ** BigInt(MONEY_SCALE);

function normalizeDecimal(value) {
  if (value === null || value === undefined) return '0';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? '0' : trimmed;
  }
  return value.toString();
}

function toScaledInteger(value) {
  if (typeof value === 'bigint') return value;

  const raw = normalizeDecimal(value);
  const sign = raw.startsWith('-') ? -1n : 1n;
  const unsigned = raw.replace(/^[-+]/, '');

  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    throw new Error(`Invalid decimal value: ${raw}`);
  }

  const [intPart, fractionPart = ''] = unsigned.split('.');
  const scaledFraction = fractionPart
    .padEnd(MONEY_SCALE, '0')
    .substring(0, MONEY_SCALE);

  return sign * (
    BigInt(intPart || '0') * MONEY_FACTOR +
    BigInt(scaledFraction || '0')
  );
}

function formatScaledInteger(value, fractionDigits = 2) {
  const safeDigits = Math.max(0, Math.min(fractionDigits, MONEY_SCALE));
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;

  const roundingFactor = 10n ** BigInt(MONEY_SCALE - safeDigits);
  const rounded = (absolute + (roundingFactor / 2n)) / roundingFactor;

  const displayFactor = 10n ** BigInt(safeDigits);
  const intPart = rounded / displayFactor;

  const fractionPart = (rounded % displayFactor)
    .toString()
    .padStart(safeDigits, '0');

  if (safeDigits === 0) {
    return `${sign}${intPart.toString()}`;
  }

  if (/^0+$/.test(fractionPart)) {
    return `${sign}${intPart.toString()}`;
  }

  return `${sign}${intPart.toString()}.${fractionPart}`;
}

module.exports = {
  MONEY_SCALE,
  MONEY_FACTOR,
  toScaledInteger,
  formatScaledInteger,
};
