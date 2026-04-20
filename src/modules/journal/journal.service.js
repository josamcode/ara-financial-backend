'use strict';

const mongoose = require('mongoose');
const { JournalEntry } = require('./journal.model');
const JournalCounter = require('./journalCounter.model');
const { Account } = require('../account/account.model');
const fiscalPeriodService = require('../fiscal-period/fiscalPeriod.service');
const auditService = require('../audit/audit.service');
const {
  BadRequestError,
  NotFoundError,
  ValidationError,
} = require('../../common/errors');
const logger = require('../../config/logger');
const { assertBalancedJournalLines } = require('./journal.invariants');

/**
 * CORE ACCOUNTING INVARIANTS enforced by this service:
 * 
 * 1. sum(debit) MUST equal sum(credit) for every entry
 * 2. Minimum 2 lines per entry (at least one debit and one credit)
 * 3. Each line must have debit OR credit, not both non-zero
 * 4. Each line must reference a valid, active, non-parent-only account
 * 5. Posted entries are immutable — corrections via reversing entry only
 * 6. Draft entries can be edited
 * 7. No operations allowed in locked fiscal periods
 * 8. No posting to frozen (inactive) or parent-only accounts
 * 9. Entry numbers are auto-incremented per tenant, never reused
 * 10. Decimal128 used for all money amounts
 */
class JournalService {
  /**
   * Create a new journal entry.
   */
  async createEntry(tenantId, userId, data, options = {}) {
    // Parse and validate the entry date
    const entryDate = new Date(data.date);

    // Check fiscal period
    const period = await this._requireOpenFiscalPeriod(tenantId, entryDate);

    // Validate lines
    await this._validateLines(tenantId, data.lines);

    // Validate double-entry balance
    this._validateBalance(data.lines);

    // Generate next entry number (atomic increment)
    const entryNumber = await this._getNextEntryNumber(tenantId);

    // Build lines with Decimal128
    const lines = data.lines.map((line, index) => ({
      accountId: new mongoose.Types.ObjectId(line.accountId),
      debit: mongoose.Types.Decimal128.fromString(line.debit || '0'),
      credit: mongoose.Types.Decimal128.fromString(line.credit || '0'),
      description: line.description || '',
      lineOrder: index + 1,
    }));

    const entry = await JournalEntry.create({
      tenantId,
      entryNumber,
      date: entryDate,
      description: data.description,
      reference: data.reference || '',
      status: 'draft',
      lines,
      fiscalPeriodId: period._id,
      createdBy: userId,
    });

    // Log audit trail
    await auditService.log({
      tenantId,
      userId,
      action: 'journal_entry.created',
      resourceType: 'JournalEntry',
      resourceId: entry._id,
      newValues: { entryNumber, description: data.description },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, entryId: entry._id, entryNumber }, 'Journal entry created');
    return entry;
  }

  /**
   * List journal entries with filters.
   */
  async listEntries(tenantId, { page, limit, skip, startDate, endDate, accountId, status, search }) {
    const filter = {
      tenantId,
      deletedAt: null,
    };

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }

    if (accountId) {
      filter['lines.accountId'] = new mongoose.Types.ObjectId(accountId);
    }

    if (status) filter.status = status;

    if (search) {
      filter.$or = [
        { description: { $regex: search, $options: 'i' } },
        { reference: { $regex: search, $options: 'i' } },
      ];
    }

    const [entries, total] = await Promise.all([
      JournalEntry.find(filter)
        .populate({
          path: 'createdBy',
          select: 'name email',
          match: { tenantId },
        })
        .sort({ date: -1, entryNumber: -1 })
        .skip(skip)
        .limit(limit),
      JournalEntry.countDocuments(filter),
    ]);

    return { entries, total };
  }

  /**
   * Get a single journal entry by ID.
   */
  async getEntryById(entryId, tenantId) {
    const entry = await JournalEntry.findOne({ _id: entryId, tenantId })
      .populate({
        path: 'createdBy',
        select: 'name email',
        match: { tenantId },
      })
      .populate({
        path: 'postedBy',
        select: 'name email',
        match: { tenantId },
      })
      .populate({
        path: 'lines.accountId',
        select: 'code nameAr nameEn type',
        match: { tenantId },
      });

    if (!entry) throw new NotFoundError('Journal entry not found');
    return entry;
  }

  /**
   * Update a draft journal entry.
   */
  async updateEntry(entryId, tenantId, userId, data, options = {}) {
    const entry = await JournalEntry.findOne({ _id: entryId, tenantId });
    if (!entry) throw new NotFoundError('Journal entry not found');

    // Only draft entries can be edited
    if (entry.status !== 'draft') {
      throw new BadRequestError('Only draft entries can be edited. Posted entries are immutable.');
    }

    const currentPeriod = await this._requireOpenFiscalPeriod(tenantId, entry.date);
    entry.fiscalPeriodId = currentPeriod._id;

    // If changing date, validate fiscal period
    if (data.date) {
      const newDate = new Date(data.date);
      const newPeriod = await this._requireOpenFiscalPeriod(tenantId, newDate);
      entry.date = newDate;
      entry.fiscalPeriodId = newPeriod._id;
    }

    if (data.description) entry.description = data.description;
    if (data.reference !== undefined) entry.reference = data.reference;

    // If updating lines, re-validate everything
    if (data.lines) {
      await this._validateLines(tenantId, data.lines);
      this._validateBalance(data.lines);

      entry.lines = data.lines.map((line, index) => ({
        accountId: new mongoose.Types.ObjectId(line.accountId),
        debit: mongoose.Types.Decimal128.fromString(line.debit || '0'),
        credit: mongoose.Types.Decimal128.fromString(line.credit || '0'),
        description: line.description || '',
        lineOrder: index + 1,
      }));
    }

    await entry.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'journal_entry.updated',
      resourceType: 'JournalEntry',
      resourceId: entry._id,
      newValues: { entryNumber: entry.entryNumber },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, entryId }, 'Journal entry updated');
    return entry;
  }

  /**
   * Post a draft entry — makes it final and immutable.
   */
  async postEntry(entryId, tenantId, userId, options = {}) {
    const entry = await JournalEntry.findOne({ _id: entryId, tenantId });
    if (!entry) throw new NotFoundError('Journal entry not found');

    if (entry.status === 'posted') {
      throw new BadRequestError('Entry is already posted');
    }

    // Re-validate balance before posting (safety net)
    const lines = entry.lines.map((l) => ({
      debit: l.debit.toString(),
      credit: l.credit.toString(),
    }));
    this._validateBalance(lines);

    const period = await this._requireOpenFiscalPeriod(tenantId, entry.date);
    entry.fiscalPeriodId = period._id;

    entry.status = 'posted';
    entry.postedAt = new Date();
    entry.postedBy = userId;
    await entry.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'journal_entry.posted',
      resourceType: 'JournalEntry',
      resourceId: entry._id,
      newValues: { entryNumber: entry.entryNumber, postedAt: entry.postedAt },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, entryId, entryNumber: entry.entryNumber }, 'Journal entry posted');
    return entry;
  }

  /**
   * Create a reversing entry for a posted entry.
   */
  async reverseEntry(entryId, tenantId, userId, options = {}) {
    const original = await JournalEntry.findOne({ _id: entryId, tenantId });
    if (!original) throw new NotFoundError('Journal entry not found');

    if (original.status !== 'posted') {
      throw new BadRequestError('Only posted entries can be reversed');
    }

    const reversalDate = new Date();
    if (original.reversalEntryId) {
      throw new BadRequestError('Entry has already been reversed');
    }

    const existingReversal = await JournalEntry.findOne({
      tenantId,
      reversedEntryId: original._id,
    });

    if (existingReversal) {
      original.reversalEntryId = existingReversal._id;
      await original.save();
      throw new BadRequestError('Entry has already been reversed');
    }

    const reversalPeriod = await this._requireOpenFiscalPeriod(tenantId, reversalDate);

    // Generate next entry number
    const entryNumber = await this._getNextEntryNumber(tenantId);

    // Create reversed lines (swap debits and credits)
    const reversedLines = original.lines.map((line, index) => ({
      accountId: line.accountId,
      debit: line.credit, // Swap: original credit becomes reversal debit
      credit: line.debit, // Swap: original debit becomes reversal credit
      description: `Reversal: ${line.description || ''}`.trim(),
      lineOrder: index + 1,
    }));

    const reversalEntry = await JournalEntry.create({
      tenantId,
      entryNumber,
      date: reversalDate,
      description: `Reversal of entry #${original.entryNumber}: ${original.description}`,
      reference: `REV-${original.entryNumber}`,
      status: 'posted',
      lines: reversedLines,
      fiscalPeriodId: reversalPeriod._id,
      createdBy: userId,
      postedAt: reversalDate,
      postedBy: userId,
      reversedEntryId: original._id,
      isReversing: true,
    });

    original.reversalEntryId = reversalEntry._id;
    await original.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'journal_entry.reversed',
      resourceType: 'JournalEntry',
      resourceId: reversalEntry._id,
      newValues: {
        entryNumber,
        originalEntryNumber: original.entryNumber,
        originalEntryId: original._id,
      },
      auditContext: options.auditContext,
    });

    logger.info(
      { tenantId, originalEntryId: entryId, reversalEntryId: reversalEntry._id },
      'Journal entry reversed'
    );
    return reversalEntry;
  }

  /**
   * Soft delete a draft entry.
   */
  async deleteEntry(entryId, tenantId, userId, options = {}) {
    const entry = await JournalEntry.findOne({ _id: entryId, tenantId });
    if (!entry) throw new NotFoundError('Journal entry not found');

    if (entry.status === 'posted') {
      throw new BadRequestError(
        'Posted entries cannot be deleted. Create a reversing entry instead.'
      );
    }

    const period = await this._requireOpenFiscalPeriod(tenantId, entry.date);
    entry.fiscalPeriodId = period._id;

    await entry.softDelete();

    await auditService.log({
      tenantId,
      userId,
      action: 'journal_entry.deleted',
      resourceType: 'JournalEntry',
      resourceId: entry._id,
      newValues: { entryNumber: entry.entryNumber },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, entryId }, 'Journal entry deleted');
  }

  // ── Invariant Validation Methods ─────────────────────

  /**
   * INVARIANT #1: sum(debit) must equal sum(credit).
   * Uses string arithmetic to avoid floating-point errors.
   */
  _validateBalance(lines) {
    assertBalancedJournalLines(lines);
  }

  /**
   * Validates all line account references.
   */
  async _validateLines(tenantId, lines) {
    const accountIds = [...new Set(lines.map((l) => l.accountId))];

    const accounts = await Account.find({
      _id: { $in: accountIds },
      tenantId,
    });

    const accountMap = new Map(accounts.map((a) => [a._id.toString(), a]));

    for (const line of lines) {
      const account = accountMap.get(line.accountId);
      if (!account) {
        throw new ValidationError(`Account ${line.accountId} not found`);
      }
      if (!account.isActive) {
        throw new ValidationError(`Account "${account.nameEn}" (${account.code}) is frozen/inactive`);
      }
      if (account.isParentOnly) {
        throw new ValidationError(
          `Account "${account.nameEn}" (${account.code}) is a parent-only account and cannot receive entries`
        );
      }
    }
  }

  /**
   * Validates that the entry date falls in an open fiscal period.
   */
  async _requireOpenFiscalPeriod(tenantId, date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new BadRequestError('Invalid journal entry date');
    }

    const period = await fiscalPeriodService.findPeriodForDate(tenantId, date, {
      required: true,
    });

    if (period.status === 'locked') {
      throw new BadRequestError(
        `Fiscal period "${period.name}" is locked. No operations allowed.`
      );
    }
    if (period.status === 'closed') {
      throw new BadRequestError(
        `Fiscal period "${period.name}" is closed. Reopen it before modifying entries.`
      );
    }

    return period;
  }

  /**
   * Generates the next sequential entry number for a tenant.
   * Uses a dedicated counter collection for atomic increments.
   */
  async _getNextEntryNumber(tenantId) {
    const key = 'journal_entry';
    const existingCounter = await JournalCounter.findOneAndUpdate(
      { tenantId, key },
      { $inc: { sequence: 1 } },
      { returnDocument: 'after' }
    );

    if (existingCounter) {
      return existingCounter.sequence;
    }

    const lastEntry = await JournalEntry.findOne({ tenantId })
      .sort({ entryNumber: -1 })
      .select('entryNumber')
      .setOptions({ __includeDeleted: true });

    const initialSequence = (lastEntry ? lastEntry.entryNumber : 0) + 1;

    try {
      const createdCounter = await JournalCounter.create({
        tenantId,
        key,
        sequence: initialSequence,
      });
      return createdCounter.sequence;
    } catch (error) {
      if (error.code === 11000) {
        const retryCounter = await JournalCounter.findOneAndUpdate(
          { tenantId, key },
          { $inc: { sequence: 1 } },
          { returnDocument: 'after' }
        );
        return retryCounter.sequence;
      }

      throw error;
    }
  }
}

module.exports = new JournalService();
