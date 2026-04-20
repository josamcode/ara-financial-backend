'use strict';

const AuditLog = require('./audit.model');
const logger = require('../../config/logger');

class AuditService {
  _normalizeContext(auditContext = {}) {
    return {
      ip: auditContext.ip || null,
      userAgent: auditContext.userAgent || null,
    };
  }

  /**
   * Create an immutable audit log entry.
   * This is a fire-and-forget operation. Failures are logged but do not
   * block the main business operation.
   */
  async log({
    tenantId,
    userId,
    action,
    resourceType,
    resourceId,
    oldValues,
    newValues,
    ip,
    userAgent,
    auditContext,
  }) {
    if (!tenantId || !userId || !action || !resourceType || !resourceId) {
      logger.warn(
        { tenantId, userId, action, resourceType, resourceId },
        'Skipping audit log with missing required fields'
      );
      return;
    }

    const context = this._normalizeContext(auditContext);

    try {
      await AuditLog.create({
        tenantId,
        userId,
        action,
        resourceType,
        resourceId,
        oldValues: oldValues ?? null,
        newValues: newValues ?? null,
        ip: ip ?? context.ip,
        userAgent: userAgent ?? context.userAgent,
      });
    } catch (err) {
      logger.error({ err, action, resourceType, resourceId }, 'Failed to create audit log');
    }
  }

  /**
   * Query audit logs for a tenant.
   */
  async getLogs(
    tenantId,
    { page, limit, skip, action, resourceType, resourceId, userId, startDate, endDate }
  ) {
    const filter = { tenantId };

    if (action) filter.action = action;
    if (resourceType) filter.resourceType = resourceType;
    if (resourceId) filter.resourceId = resourceId;
    if (userId) filter.userId = userId;

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .populate({
          path: 'userId',
          select: 'name email',
          match: { tenantId },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      AuditLog.countDocuments(filter),
    ]);

    return { logs, total };
  }
}

module.exports = new AuditService();
