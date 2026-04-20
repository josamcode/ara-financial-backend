'use strict';

const { ValidationError } = require('../../common/errors');
const {
  toScaledInteger,
  formatScaledInteger,
} = require('../../common/utils/money');

function getJournalLinesValidationMessage(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    return 'A journal entry must have at least 2 lines';
  }

  let totalDebit = 0n;
  let totalCredit = 0n;

  for (const line of lines) {
    const debit = toScaledInteger(line?.debit || '0');
    const credit = toScaledInteger(line?.credit || '0');

    if (debit < 0n || credit < 0n) {
      return 'Debit and credit amounts cannot be negative';
    }

    if (debit === 0n && credit === 0n) {
      return 'Each line must have either a debit or a credit amount';
    }

    if (debit > 0n && credit > 0n) {
      return 'A line cannot have both debit and credit amounts';
    }

    totalDebit += debit;
    totalCredit += credit;
  }

  if (totalDebit === 0n || totalCredit === 0n) {
    return 'Entry must have at least one debit and one credit line';
  }

  if (totalDebit !== totalCredit) {
    return (
      `Entry is not balanced. Total debits (${formatScaledInteger(totalDebit, 6)}) ` +
      `must equal total credits (${formatScaledInteger(totalCredit, 6)})`
    );
  }

  return null;
}

function assertBalancedJournalLines(lines) {
  const message = getJournalLinesValidationMessage(lines);
  if (message) {
    throw new ValidationError(message);
  }
}

module.exports = {
  getJournalLinesValidationMessage,
  assertBalancedJournalLines,
};
