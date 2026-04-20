'use strict';

const { FiscalPeriod } = require('./fiscalPeriod.model');
const Tenant = require('../tenant/tenant.model');
const auditService = require('../audit/audit.service');
const { NotFoundError, BadRequestError } = require('../../common/errors');
const logger = require('../../config/logger');

function toUtcMonthStart(year, month) {
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
}

function addUtcMonths(date, months) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + months,
    1,
    0,
    0,
    0,
    0
  ));
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

class FiscalPeriodService {
  /**
   * List fiscal periods for a tenant.
   */
  async listPeriods(tenantId, { year }) {
    const filter = { tenantId };
    if (year) filter.year = parseInt(year, 10);
    return FiscalPeriod.find(filter).sort({ startDate: 1 });
  }

  /**
   * Get a single fiscal period.
   */
  async getPeriodById(periodId, tenantId) {
    const period = await FiscalPeriod.findOne({ _id: periodId, tenantId });
    if (!period) throw new NotFoundError('Fiscal period not found');
    return period;
  }

  /**
   * Create a full fiscal year with monthly periods.
   */
  async createFiscalYear(tenantId, { year, startMonth }, options = {}) {
    // Check if any periods exist for this year
    const existing = await FiscalPeriod.countDocuments({ tenantId, year });
    if (existing > 0) {
      throw new BadRequestError(`Fiscal year ${year} already has periods`);
    }

    const resolvedStartMonth = await this._resolveFiscalYearStartMonth(tenantId, startMonth);
    const periods = this._buildFiscalYearPeriods(tenantId, year, resolvedStartMonth);
    await this._assertNoOverlapsOrGaps(tenantId, periods);

    const created = await FiscalPeriod.insertMany(periods);

    if (options.userId && created.length > 0) {
      await auditService.log({
        tenantId,
        userId: options.userId,
        action: 'fiscal_year.created',
        resourceType: 'FiscalPeriod',
        resourceId: created[0]._id,
        newValues: {
          year,
          startMonth: resolvedStartMonth,
          periodCount: created.length,
        },
        auditContext: options.auditContext,
      });
    }

    logger.info({ tenantId, year, count: created.length }, 'Fiscal year created');
    return created;
  }

  /**
   * Close a fiscal period.
   */
  async closePeriod(periodId, tenantId, userId, options = {}) {
    const period = await FiscalPeriod.findOne({ _id: periodId, tenantId });
    if (!period) throw new NotFoundError('Fiscal period not found');
    if (period.status === 'locked') throw new BadRequestError('Period is already locked');
    if (period.status === 'closed') throw new BadRequestError('Period is already closed');

    const oldValues = {
      status: period.status,
      closedAt: period.closedAt,
      closedBy: period.closedBy,
    };

    period.status = 'closed';
    period.closedAt = new Date();
    period.closedBy = userId;
    await period.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'fiscal_period.closed',
      resourceType: 'FiscalPeriod',
      resourceId: period._id,
      oldValues,
      newValues: {
        status: period.status,
        closedAt: period.closedAt,
        closedBy: period.closedBy,
      },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, periodId, name: period.name }, 'Fiscal period closed');
    return period;
  }

  /**
   * Lock a fiscal period (irreversible without special permission).
   */
  async lockPeriod(periodId, tenantId, userId, options = {}) {
    const period = await FiscalPeriod.findOne({ _id: periodId, tenantId });
    if (!period) throw new NotFoundError('Fiscal period not found');
    if (period.status === 'locked') throw new BadRequestError('Period is already locked');

    const oldValues = {
      status: period.status,
      lockedAt: period.lockedAt,
      lockedBy: period.lockedBy,
    };

    period.status = 'locked';
    period.lockedAt = new Date();
    period.lockedBy = userId;
    await period.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'fiscal_period.locked',
      resourceType: 'FiscalPeriod',
      resourceId: period._id,
      oldValues,
      newValues: {
        status: period.status,
        lockedAt: period.lockedAt,
        lockedBy: period.lockedBy,
      },
      auditContext: options.auditContext,
    });

    logger.info({ tenantId, periodId, name: period.name }, 'Fiscal period locked');
    return period;
  }

  /**
   * Reopen a closed (not locked) period.
   */
  async reopenPeriod(periodId, tenantId, options = {}) {
    const period = await FiscalPeriod.findOne({ _id: periodId, tenantId });
    if (!period) throw new NotFoundError('Fiscal period not found');
    if (period.status === 'locked') throw new BadRequestError('Locked periods cannot be reopened');
    if (period.status === 'open') throw new BadRequestError('Period is already open');

    const oldValues = {
      status: period.status,
      closedAt: period.closedAt,
      closedBy: period.closedBy,
    };

    period.status = 'open';
    period.closedAt = null;
    period.closedBy = null;
    await period.save();

    if (options.userId) {
      await auditService.log({
        tenantId,
        userId: options.userId,
        action: 'fiscal_period.reopened',
        resourceType: 'FiscalPeriod',
        resourceId: period._id,
        oldValues,
        newValues: {
          status: period.status,
          closedAt: period.closedAt,
          closedBy: period.closedBy,
        },
        auditContext: options.auditContext,
      });
    }

    logger.info({ tenantId, periodId, name: period.name }, 'Fiscal period reopened');
    return period;
  }

  /**
   * Find the fiscal period for a given date.
   */
  async findPeriodForDate(tenantId, date, options = {}) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new BadRequestError('Invalid fiscal period date');
    }

    const periods = await FiscalPeriod.find({
      tenantId,
      startDate: { $lte: date },
      endDate: { $gte: date },
    })
      .sort({ startDate: 1 })
      .limit(2);

    if (periods.length === 0) {
      if (!options.required) {
        return null;
      }

      throw new BadRequestError(
        `No fiscal period found for ${formatIsoDate(date)}. ` +
        'Create and open the matching fiscal period first.'
      );
    }

    if (periods.length > 1) {
      throw new BadRequestError(
        `Multiple fiscal periods match ${formatIsoDate(date)}. Resolve overlapping periods first.`
      );
    }

    return periods[0];
  }

  async _resolveFiscalYearStartMonth(tenantId, explicitStartMonth) {
    if (explicitStartMonth !== undefined && explicitStartMonth !== null) {
      return explicitStartMonth;
    }

    const earliestPeriod = await FiscalPeriod.findOne({ tenantId })
      .sort({ startDate: 1 })
      .select('startDate')
      .lean();

    if (earliestPeriod?.startDate) {
      return earliestPeriod.startDate.getUTCMonth() + 1;
    }

    const tenant = await Tenant.findById(tenantId)
      .select('fiscalYearStartMonth')
      .lean();

    return tenant?.fiscalYearStartMonth || 1;
  }

  _buildFiscalYearPeriods(tenantId, year, startMonth) {
    const firstPeriodStart = toUtcMonthStart(year, startMonth);
    const periods = [];

    for (let i = 0; i < 12; i++) {
      const startDate = addUtcMonths(firstPeriodStart, i);
      const nextStartDate = addUtcMonths(firstPeriodStart, i + 1);
      const periodYear = startDate.getUTCFullYear();
      const periodMonth = startDate.getUTCMonth() + 1;

      periods.push({
        tenantId,
        name: `${periodYear}-${String(periodMonth).padStart(2, '0')}`,
        startDate,
        endDate: new Date(nextStartDate.getTime() - 1),
        year,
        month: periodMonth,
        status: 'open',
      });
    }

    return periods;
  }

  async _assertNoOverlapsOrGaps(tenantId, periods) {
    const proposedStartDate = periods[0].startDate;
    const proposedEndDate = periods[periods.length - 1].endDate;

    const overlappingPeriod = await FiscalPeriod.findOne({
      tenantId,
      startDate: { $lte: proposedEndDate },
      endDate: { $gte: proposedStartDate },
    })
      .sort({ startDate: 1 })
      .select('name');

    if (overlappingPeriod) {
      throw new BadRequestError(
        `Fiscal periods cannot overlap existing period "${overlappingPeriod.name}".`
      );
    }

    const previousPeriod = await FiscalPeriod.findOne({
      tenantId,
      endDate: { $lt: proposedStartDate },
    })
      .sort({ endDate: -1 })
      .select('name endDate');

    if (previousPeriod && previousPeriod.endDate.getTime() + 1 !== proposedStartDate.getTime()) {
      throw new BadRequestError(
        `Fiscal periods must be continuous. A gap exists after "${previousPeriod.name}".`
      );
    }

    const nextPeriod = await FiscalPeriod.findOne({
      tenantId,
      startDate: { $gt: proposedEndDate },
    })
      .sort({ startDate: 1 })
      .select('name startDate');

    if (nextPeriod && proposedEndDate.getTime() + 1 !== nextPeriod.startDate.getTime()) {
      throw new BadRequestError(
        `Fiscal periods must be continuous. A gap exists before "${nextPeriod.name}".`
      );
    }
  }
}

module.exports = new FiscalPeriodService();
