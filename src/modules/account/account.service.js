'use strict';

const mongoose = require('mongoose');
const { Account, TYPE_NATURE_MAP } = require('./account.model');
const EGYPTIAN_COA_TEMPLATE = require('../../seeds/egyptian-coa');
const auditService = require('../audit/audit.service');
const {
  NotFoundError,
  BadRequestError,
  ConflictError,
} = require('../../common/errors');
const logger = require('../../config/logger');

function isTransactionUnsupported(error) {
  const message = error?.message || '';
  return (
    error?.code === 20 ||
    message.includes('Transaction numbers are only allowed on a replica set member or mongos') ||
    message.includes('Transaction support is not enabled')
  );
}

class AccountService {
  /**
   * List accounts with optional filters.
   */
  async listAccounts(tenantId, { type, isActive, isParentOnly, search, page, limit, skip }) {
    const filter = { tenantId };
    if (type) filter.type = type;
    if (isActive !== undefined) filter.isActive = isActive;
    if (isParentOnly !== undefined) filter.isParentOnly = isParentOnly;
    if (search) {
      filter.$or = [
        { nameAr: { $regex: search, $options: 'i' } },
        { nameEn: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }

    const [accounts, total] = await Promise.all([
      Account.find(filter).sort({ code: 1 }).skip(skip).limit(limit),
      Account.countDocuments(filter),
    ]);

    return { accounts, total };
  }

  /**
   * Get accounts as a hierarchical tree.
   */
  async getAccountTree(tenantId) {
    const accounts = await Account.find({ tenantId }).sort({ code: 1 }).lean();

    const accountMap = {};
    const roots = [];

    for (const account of accounts) {
      account.children = [];
      accountMap[account._id.toString()] = account;
    }

    for (const account of accounts) {
      if (account.parentId) {
        const parent = accountMap[account.parentId.toString()];
        if (parent) {
          parent.children.push(account);
        } else {
          roots.push(account);
        }
      } else {
        roots.push(account);
      }
    }

    return roots;
  }

  /**
   * Get a single account by ID.
   */
  async getAccountById(accountId, tenantId) {
    const account = await Account.findOne({ _id: accountId, tenantId });
    if (!account) throw new NotFoundError('Account not found');
    return account;
  }

  /**
   * Create a new account.
   */
  async createAccount(tenantId, data, options = {}) {
    const existing = await Account.findOne({ tenantId, code: data.code });
    if (existing) throw new ConflictError(`Account code "${data.code}" already exists`);

    let level = 1;

    if (data.parentId) {
      const parent = await Account.findOne({ _id: data.parentId, tenantId });
      if (!parent) throw new BadRequestError('Parent account not found');
      if (parent.level >= 6) throw new BadRequestError('Maximum account depth (6 levels) reached');
      level = parent.level + 1;

      if (data.type !== parent.type) {
        throw new BadRequestError(`Child account type must match parent type (${parent.type})`);
      }
    }

    const nature = data.nature || TYPE_NATURE_MAP[data.type];

    const account = await Account.create({
      tenantId,
      code: data.code,
      nameAr: data.nameAr,
      nameEn: data.nameEn,
      type: data.type,
      nature,
      parentId: data.parentId || null,
      level,
      isParentOnly: data.isParentOnly || false,
    });

    if (options.userId) {
      await auditService.log({
        tenantId,
        userId: options.userId,
        action: 'account.created',
        resourceType: 'Account',
        resourceId: account._id,
        newValues: {
          code: account.code,
          nameAr: account.nameAr,
          nameEn: account.nameEn,
          type: account.type,
          nature: account.nature,
          parentId: account.parentId,
          isParentOnly: account.isParentOnly,
          isActive: account.isActive,
        },
        auditContext: options.auditContext,
      });
    }

    logger.info({ tenantId, accountId: account._id, code: data.code }, 'Account created');
    return account;
  }

  /**
   * Update an account.
   */
  async updateAccount(accountId, tenantId, data, options = {}) {
    const account = await Account.findOne({ _id: accountId, tenantId });
    if (!account) throw new NotFoundError('Account not found');

    if (account.systemAccount) {
      throw new BadRequestError('System accounts cannot be modified');
    }

    const oldValues = {
      nameAr: account.nameAr,
      nameEn: account.nameEn,
      parentId: account.parentId,
      level: account.level,
      isActive: account.isActive,
      isParentOnly: account.isParentOnly,
    };

    if (data.nameAr !== undefined) account.nameAr = data.nameAr;
    if (data.nameEn !== undefined) account.nameEn = data.nameEn;
    if (data.isActive !== undefined) account.isActive = data.isActive;
    if (data.isParentOnly !== undefined) account.isParentOnly = data.isParentOnly;

    if (data.parentId !== undefined) {
      if (data.parentId) {
        if (this._idsEqual(data.parentId, account._id)) {
          throw new BadRequestError('Account cannot be its own parent');
        }

        const newParent = await Account.findOne({ _id: data.parentId, tenantId });
        if (!newParent) throw new BadRequestError('Parent account not found');
        if (newParent.level >= 6) throw new BadRequestError('Maximum depth reached');
        if (newParent.type !== account.type) {
          throw new BadRequestError('Parent must have the same account type');
        }

        await this._assertParentMoveIsAcyclic(account._id, newParent, tenantId);

        account.parentId = data.parentId;
        account.level = newParent.level + 1;
      } else {
        account.parentId = null;
        account.level = 1;
      }
    }

    await account.save();

    if (options.userId) {
      await auditService.log({
        tenantId,
        userId: options.userId,
        action: 'account.updated',
        resourceType: 'Account',
        resourceId: account._id,
        oldValues,
        newValues: {
          nameAr: account.nameAr,
          nameEn: account.nameEn,
          parentId: account.parentId,
          level: account.level,
          isActive: account.isActive,
          isParentOnly: account.isParentOnly,
        },
        auditContext: options.auditContext,
      });
    }

    logger.info({ tenantId, accountId }, 'Account updated');
    return account;
  }

  /**
   * Soft delete an account.
   */
  async deleteAccount(accountId, tenantId, options = {}) {
    const account = await Account.findOne({ _id: accountId, tenantId });
    if (!account) throw new NotFoundError('Account not found');

    if (account.systemAccount) {
      throw new BadRequestError('System accounts cannot be deleted');
    }

    const childCount = await Account.countDocuments({ tenantId, parentId: accountId });
    if (childCount > 0) {
      throw new BadRequestError('Cannot delete an account that has child accounts');
    }

    const { JournalEntry } = require('../journal/journal.model');
    const entryCount = await JournalEntry.countDocuments({
      tenantId,
      'lines.accountId': accountId,
    }).setOptions({ __includeDeleted: true });

    if (entryCount > 0) {
      throw new BadRequestError('Cannot delete an account that has journal entries');
    }

    const oldValues = {
      code: account.code,
      nameAr: account.nameAr,
      nameEn: account.nameEn,
      type: account.type,
      nature: account.nature,
      parentId: account.parentId,
      isParentOnly: account.isParentOnly,
      isActive: account.isActive,
    };

    await account.softDelete();

    if (options.userId) {
      await auditService.log({
        tenantId,
        userId: options.userId,
        action: 'account.deleted',
        resourceType: 'Account',
        resourceId: account._id,
        oldValues,
        auditContext: options.auditContext,
      });
    }

    logger.info({ tenantId, accountId }, 'Account deleted');
    return account;
  }

  /**
   * Apply the Egyptian CoA template for a tenant.
   */
  async applyTemplate(tenantId, templateName = 'egyptian', options = {}) {
    const template = EGYPTIAN_COA_TEMPLATE;
    let createdCount = 0;

    const session = await mongoose.startSession();

    try {
      try {
        await session.withTransaction(async () => {
          createdCount = await this._seedTemplateAccounts(tenantId, template, {
            session,
          });
        });
      } catch (error) {
        if (!isTransactionUnsupported(error)) {
          throw error;
        }

        createdCount = await this._seedTemplateAccountsWithCompensation(
          tenantId,
          template
        );
      }
    } finally {
      await session.endSession();
    }

    if (options.userId) {
      await auditService.log({
        tenantId,
        userId: options.userId,
        action: 'account.template_applied',
        resourceType: 'Tenant',
        resourceId: tenantId,
        newValues: {
          templateName,
          accountCount: createdCount,
        },
        auditContext: options.auditContext,
      });
    }

    logger.info({ tenantId, accountCount: createdCount }, 'CoA template applied');
    return createdCount;
  }

  _idsEqual(left, right) {
    return String(left) === String(right);
  }

  async _seedTemplateAccounts(tenantId, template, options = {}) {
    const existingQuery = Account.countDocuments({ tenantId });
    if (options.session) {
      existingQuery.session(options.session);
    }

    const existingCount = await existingQuery;
    if (existingCount > 0) {
      throw new BadRequestError('Template can only be applied once during initial setup');
    }

    const codeToId = {};
    const accountsToCreate = [];

    for (const item of template) {
      accountsToCreate.push({
        tenantId,
        code: item.code,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        type: item.type,
        nature: item.nature,
        level: item.level,
        isParentOnly: item.isParentOnly || false,
        systemAccount: item.systemAccount || false,
        parentId: null,
      });
    }

    const insertOptions = options.session ? { session: options.session } : undefined;
    const createdAccounts = insertOptions
      ? await Account.insertMany(accountsToCreate, insertOptions)
      : await Account.insertMany(accountsToCreate);

    for (const account of createdAccounts) {
      codeToId[account.code] = account._id;
    }

    const bulkOps = [];
    for (let i = 0; i < template.length; i++) {
      const item = template[i];
      if (item.parentCode) {
        const parentId = codeToId[item.parentCode];
        if (parentId) {
          bulkOps.push({
            updateOne: {
              filter: { _id: createdAccounts[i]._id },
              update: { $set: { parentId } },
            },
          });
        }
      }
    }

    if (bulkOps.length > 0) {
      if (options.session) {
        await Account.bulkWrite(bulkOps, { session: options.session });
      } else {
        await Account.bulkWrite(bulkOps);
      }
    }

    return createdAccounts.length;
  }

  async _seedTemplateAccountsWithCompensation(tenantId, template) {
    try {
      return await this._seedTemplateAccounts(tenantId, template);
    } catch (error) {
      await this._cleanupPartialTemplateApplication(tenantId, template);
      throw error;
    }
  }

  async _cleanupPartialTemplateApplication(tenantId, template) {
    try {
      await Account.deleteMany({
        tenantId,
        code: { $in: template.map((item) => item.code) },
      });
    } catch (cleanupError) {
      logger.error(
        { err: cleanupError, tenantId },
        'Failed to clean up partially applied chart of accounts template'
      );
    }
  }

  async _assertParentMoveIsAcyclic(accountId, candidateParent, tenantId) {
    const visited = new Set([String(accountId)]);
    let current = candidateParent;

    while (current) {
      const currentId = String(current._id);

      if (visited.has(currentId)) {
        if (currentId === String(accountId)) {
          throw new BadRequestError('Cannot assign a descendant account as parent');
        }

        throw new BadRequestError('Account hierarchy contains a cycle');
      }

      visited.add(currentId);

      if (!current.parentId) {
        return;
      }

      current = await Account.findOne({
        _id: current.parentId,
        tenantId,
      }).select('_id parentId');
    }
  }
}

module.exports = new AccountService();
