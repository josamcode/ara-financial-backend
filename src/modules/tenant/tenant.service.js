'use strict';

const Tenant = require('./tenant.model');
const auditService = require('../audit/audit.service');
const { NotFoundError, ForbiddenError } = require('../../common/errors');
const logger = require('../../config/logger');

class TenantService {
  /**
   * Get tenant details by ID.
   */
  async getTenant(tenantId) {
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant not found');
    return tenant;
  }

  /**
   * Update tenant settings.
   */
  async updateSettings(tenantId, updates, options = {}) {
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant not found');

    const oldValues = {
      name: tenant.name,
      legalName: tenant.legalName,
      taxId: tenant.taxId,
      logoUrl: tenant.logoUrl,
      industry: tenant.industry,
      fiscalYearStartMonth: tenant.fiscalYearStartMonth,
      settings: {
        dateFormat: tenant.settings.dateFormat,
        numberFormat: tenant.settings.numberFormat,
        language: tenant.settings.language,
      },
    };

    const allowedFields = [
      'name', 'legalName', 'taxId', 'logoUrl', 'industry',
      'fiscalYearStartMonth',
    ];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        tenant[field] = updates[field];
      }
    }

    // Settings sub-object
    if (updates.settings) {
      if (updates.settings.dateFormat) tenant.settings.dateFormat = updates.settings.dateFormat;
      if (updates.settings.numberFormat) tenant.settings.numberFormat = updates.settings.numberFormat;
      if (updates.settings.language) tenant.settings.language = updates.settings.language;
    }

    await tenant.save();

    if (options.userId) {
      await auditService.log({
        tenantId,
        userId: options.userId,
        action: 'tenant.settings_updated',
        resourceType: 'Tenant',
        resourceId: tenant._id,
        oldValues,
        newValues: {
          name: tenant.name,
          legalName: tenant.legalName,
          taxId: tenant.taxId,
          logoUrl: tenant.logoUrl,
          industry: tenant.industry,
          fiscalYearStartMonth: tenant.fiscalYearStartMonth,
          settings: {
            dateFormat: tenant.settings.dateFormat,
            numberFormat: tenant.settings.numberFormat,
            language: tenant.settings.language,
          },
        },
        auditContext: options.auditContext,
      });
    }

    logger.info({ tenantId }, 'Tenant settings updated');
    return tenant;
  }

  /**
   * Complete the setup wizard.
   */
  async completeSetup(tenantId, options = {}) {
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant not found');
    const oldValues = { setupCompleted: tenant.setupCompleted };
    tenant.setupCompleted = true;
    await tenant.save();

    if (options.userId) {
      await auditService.log({
        tenantId,
        userId: options.userId,
        action: 'tenant.setup_completed',
        resourceType: 'Tenant',
        resourceId: tenant._id,
        oldValues,
        newValues: { setupCompleted: tenant.setupCompleted },
        auditContext: options.auditContext,
      });
    }

    logger.info({ tenantId }, 'Tenant setup completed');
    return tenant;
  }
}

module.exports = new TenantService();
