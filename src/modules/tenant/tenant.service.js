'use strict';

const Tenant = require('./tenant.model');
const currencyService = require('../currency/currency.service');
const { JournalEntry } = require('../journal/journal.model');
const { Invoice } = require('../invoice/invoice.model');
const { Bill } = require('../bill/bill.model');
const auditService = require('../audit/audit.service');
const { BadRequestError, NotFoundError } = require('../../common/errors');
const { deleteTenantLogo, uploadTenantLogo } = require('../../config/cloudinary');
const logger = require('../../config/logger');

function normalizeOptionalString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  return trimmed || null;
}

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
      companyEmail: tenant.companyEmail,
      companyPhone: tenant.companyPhone,
      companyAddress: tenant.companyAddress,
      industry: tenant.industry,
      fiscalYearStartMonth: tenant.fiscalYearStartMonth,
      settings: {
        dateFormat: tenant.settings.dateFormat,
        numberFormat: tenant.settings.numberFormat,
        language: tenant.settings.language,
      },
    };

    const allowedFields = [
      'name', 'legalName', 'taxId', 'logoUrl', 'companyEmail', 'companyPhone',
      'companyAddress', 'industry',
      'fiscalYearStartMonth',
    ];
    const normalizedFields = new Set([
      'legalName',
      'taxId',
      'logoUrl',
      'companyEmail',
      'companyPhone',
      'companyAddress',
    ]);

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        tenant[field] = normalizedFields.has(field)
          ? normalizeOptionalString(updates[field])
          : updates[field];
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
          companyEmail: tenant.companyEmail,
          companyPhone: tenant.companyPhone,
          companyAddress: tenant.companyAddress,
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
   * Update tenant base currency only while the tenant has no accounting activity.
   */
  async updateBaseCurrency(tenantId, baseCurrency, options = {}) {
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant not found');

    const currency = await currencyService.requireActiveCurrency(baseCurrency);
    const normalizedBaseCurrency = currency.code;
    const currentBaseCurrency = (tenant.baseCurrency || 'SAR').toUpperCase();

    if (currentBaseCurrency === normalizedBaseCurrency) {
      return tenant;
    }

    if (await this._hasAccountingActivity(tenantId)) {
      throw new BadRequestError(
        'Base currency cannot be changed after accounting activity exists',
        'BASE_CURRENCY_LOCKED'
      );
    }

    const oldValues = { baseCurrency: tenant.baseCurrency || null };
    tenant.baseCurrency = normalizedBaseCurrency;
    await tenant.save();

    if (options.userId) {
      await auditService.log({
        tenantId,
        userId: options.userId,
        action: 'tenant.base_currency_updated',
        resourceType: 'Tenant',
        resourceId: tenant._id,
        oldValues,
        newValues: { baseCurrency: tenant.baseCurrency },
        auditContext: options.auditContext,
      });
    }

    logger.info({ tenantId, baseCurrency: tenant.baseCurrency }, 'Tenant base currency updated');
    return tenant;
  }

  /**
   * Upload and persist tenant logo.
   */
  async uploadLogo(tenantId, file, options = {}) {
    if (!file?.buffer) {
      throw new BadRequestError('Logo image is required');
    }

    const tenant = await Tenant.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant not found');

    const oldValues = { logoUrl: tenant.logoUrl };
    const logoUrl = await uploadTenantLogo({ tenantId, file });

    if (tenant.logoUrl && tenant.logoUrl !== logoUrl) {
      try {
        await deleteTenantLogo(tenant.logoUrl);
      } catch (error) {
        logger.warn({ tenantId, error, logoUrl: tenant.logoUrl }, 'Failed to delete previous tenant logo');
      }
    }

    tenant.logoUrl = logoUrl;
    await tenant.save();

    if (options.userId) {
      await auditService.log({
        tenantId,
        userId: options.userId,
        action: 'tenant.logo_updated',
        resourceType: 'Tenant',
        resourceId: tenant._id,
        oldValues,
        newValues: { logoUrl: tenant.logoUrl },
        auditContext: options.auditContext,
      });
    }

    logger.info({ tenantId }, 'Tenant logo updated');
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

  async _hasAccountingActivity(tenantId) {
    const [journalEntries, invoices, bills] = await Promise.all([
      JournalEntry.countDocuments({ tenantId }).setOptions({ __includeDeleted: true }),
      Invoice.countDocuments({ tenantId }).setOptions({ __includeDeleted: true }),
      Bill.countDocuments({ tenantId }).setOptions({ __includeDeleted: true }),
    ]);

    return journalEntries > 0 || invoices > 0 || bills > 0;
  }
}

module.exports = new TenantService();
