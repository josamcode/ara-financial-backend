'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');

/**
 * System permissions used across the application.
 * Pattern: resource:action
 */
const PERMISSIONS = {
  // Account permissions
  ACCOUNT_READ: 'account:read',
  ACCOUNT_CREATE: 'account:create',
  ACCOUNT_UPDATE: 'account:update',
  ACCOUNT_DELETE: 'account:delete',

  // Journal entry permissions
  JOURNAL_READ: 'journal:read',
  JOURNAL_CREATE: 'journal:create',
  JOURNAL_UPDATE: 'journal:update',
  JOURNAL_DELETE: 'journal:delete',
  JOURNAL_POST: 'journal:post',

  // Report permissions
  REPORT_VIEW: 'report:view',
  REPORT_EXPORT: 'report:export',

  // User management permissions
  USER_READ: 'user:read',
  USER_INVITE: 'user:invite',
  USER_UPDATE: 'user:update',
  USER_DEACTIVATE: 'user:deactivate',

  // Tenant permissions
  TENANT_READ: 'tenant:read',
  TENANT_UPDATE: 'tenant:update',
  TENANT_DELETE: 'tenant:delete',

  // Fiscal period permissions
  FISCAL_READ: 'fiscal:read',
  FISCAL_CREATE: 'fiscal:create',
  FISCAL_UPDATE: 'fiscal:update',
  FISCAL_LOCK: 'fiscal:lock',

  // Invoice permissions
  INVOICE_READ: 'invoice:read',
  INVOICE_CREATE: 'invoice:create',
  INVOICE_UPDATE: 'invoice:update',
  INVOICE_DELETE: 'invoice:delete',
  INVOICE_SEND: 'invoice:send',

  // Payment permissions
  PAYMENT_READ: 'payment:read',
  PAYMENT_CREATE: 'payment:create',

  // Customer permissions
  CUSTOMER_READ: 'customer:read',
  CUSTOMER_CREATE: 'customer:create',
  CUSTOMER_UPDATE: 'customer:update',
  CUSTOMER_DELETE: 'customer:delete',

  // Supplier permissions
  SUPPLIER_READ: 'supplier:read',
  SUPPLIER_CREATE: 'supplier:create',
  SUPPLIER_UPDATE: 'supplier:update',
  SUPPLIER_DELETE: 'supplier:delete',

  // Bill permissions
  BILL_READ: 'bill:read',
  BILL_CREATE: 'bill:create',

  // Audit permissions
  AUDIT_READ: 'audit:read',

  // Dashboard permissions
  DASHBOARD_VIEW: 'dashboard:view',
};

/**
 * Default role definitions with their permissions.
 */
const DEFAULT_ROLES = {
  owner: {
    name: 'owner',
    label: 'Owner',
    permissions: Object.values(PERMISSIONS),
    isSystem: true,
  },
  admin: {
    name: 'admin',
    label: 'Admin',
    permissions: Object.values(PERMISSIONS).filter(
      (p) => p !== PERMISSIONS.TENANT_DELETE
    ),
    isSystem: true,
  },
  accountant: {
    name: 'accountant',
    label: 'Accountant',
    permissions: [
      PERMISSIONS.ACCOUNT_READ,
      PERMISSIONS.JOURNAL_READ,
      PERMISSIONS.JOURNAL_CREATE,
      PERMISSIONS.JOURNAL_UPDATE,
      PERMISSIONS.JOURNAL_POST,
      PERMISSIONS.REPORT_VIEW,
      PERMISSIONS.REPORT_EXPORT,
      PERMISSIONS.FISCAL_READ,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.USER_READ,
      PERMISSIONS.TENANT_READ,
      PERMISSIONS.INVOICE_READ,
      PERMISSIONS.INVOICE_CREATE,
      PERMISSIONS.INVOICE_UPDATE,
      PERMISSIONS.INVOICE_SEND,
      PERMISSIONS.CUSTOMER_READ,
      PERMISSIONS.CUSTOMER_CREATE,
      PERMISSIONS.CUSTOMER_UPDATE,
      PERMISSIONS.SUPPLIER_READ,
      PERMISSIONS.SUPPLIER_CREATE,
      PERMISSIONS.SUPPLIER_UPDATE,
      PERMISSIONS.BILL_READ,
      PERMISSIONS.BILL_CREATE,
    ],
    isSystem: true,
  },
};

function getEffectivePermissions(role) {
  if (!role) return [];

  const storedPermissions = Array.isArray(role.permissions) ? role.permissions : [];
  const defaultPermissions = role.isSystem && DEFAULT_ROLES[role.name]
    ? DEFAULT_ROLES[role.name].permissions
    : [];

  return [...new Set([...storedPermissions, ...defaultPermissions])];
}

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    permissions: {
      type: [String],
      default: [],
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

roleSchema.plugin(tenantPlugin);
roleSchema.index({ tenantId: 1, name: 1 }, { unique: true });

const Role = mongoose.model('Role', roleSchema);

/**
 * Seeds default roles for a new tenant.
 * @param {ObjectId} tenantId
 * @returns {Object} Map of role names to role documents
 */
async function seedDefaultRoles(tenantId, options = {}) {
  const roleDocs = Object.values(DEFAULT_ROLES).map((def) => ({
    tenantId,
    name: def.name,
    label: def.label,
    permissions: def.permissions,
    isSystem: def.isSystem,
  }));

  const createdRoles = await Role.insertMany(roleDocs, {
    session: options.session,
  });

  return createdRoles.reduce((roles, role) => {
    roles[role.name] = role;
    return roles;
  }, {});
}

module.exports = { Role, PERMISSIONS, DEFAULT_ROLES, seedDefaultRoles, getEffectivePermissions };
