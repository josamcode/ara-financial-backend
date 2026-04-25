'use strict';

const crypto = require('crypto');
const User = require('./user.model');
const { Role } = require('../auth/role.model');
const auditService = require('../audit/audit.service');
const billingLimitsService = require('../billing/billing-limits.service');
const config = require('../../config');
const {
  NotFoundError,
  ConflictError,
  BadRequestError,
  ForbiddenError,
} = require('../../common/errors');
const logger = require('../../config/logger');

const ROLE_HIERARCHY = Object.freeze({
  accountant: 1,
  admin: 2,
  owner: 3,
});

function getRoleRank(role) {
  return ROLE_HIERARCHY[role?.name] || 0;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function buildActionUrl(pathname, token) {
  if (!config.urls.appBaseUrl) {
    return null;
  }

  try {
    const url = new URL(pathname, config.urls.appBaseUrl);
    url.searchParams.set('token', token);
    return url.toString();
  } catch {
    return null;
  }
}

class UserService {
  /**
   * List all users in a tenant.
   */
  async listUsers(tenantId, { page, limit, skip }) {
    const filter = { tenantId };
    const [users, total] = await Promise.all([
      User.find(filter)
        .populate({
          path: 'roleId',
          select: 'name label',
          match: { tenantId },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      User.countDocuments(filter),
    ]);
    return { users, total };
  }

  /**
   * Get a single user by ID within their tenant.
   */
  async getUserById(userId, tenantId) {
    const user = await User.findOne({ _id: userId, tenantId })
      .populate({
        path: 'roleId',
        select: 'name label permissions',
        match: { tenantId },
      });
    if (!user) throw new NotFoundError('User not found');
    return user;
  }

  /**
   * Get the current user's profile within their tenant.
   */
  async getProfile(userId, tenantId) {
    const user = await this.getUserById(userId, tenantId);
    return user.toJSON();
  }

  /**
   * Invite a new user to the tenant.
   */
  async inviteUser(tenantId, invitedByUserId, { email, name, roleName }, options = {}) {
    const normalizedEmail = normalizeEmail(email);

    // Check if email already exists
    const existing = await User.findOne({ email: normalizedEmail }).setOptions({
      __skipTenantFilter: true,
    });
    if (existing) {
      throw new ConflictError('A user with this email already exists');
    }

    // Find the role
    const role = await Role.findOne({ tenantId, name: roleName });
    if (!role) throw new BadRequestError(`Role "${roleName}" not found`);

    await billingLimitsService.assertUserLimit(tenantId);

    // Generate invitation token
    const invitationToken = crypto.randomBytes(32).toString('hex');
    const invitationTokenHash = hashToken(invitationToken);
    const invitationExpiresAt = new Date(
      Date.now() + (config.auth.invitationExpirySeconds * 1000)
    );

    // Create user with temporary password (will be set on invite acceptance)
    const tempPassword = crypto.randomBytes(16).toString('hex');
    const user = await User.create({
      email: normalizedEmail,
      passwordHash: tempPassword,
      name,
      tenantId,
      roleId: role._id,
      isActive: false, // Activated on invite acceptance
      invitationToken: invitationTokenHash,
      invitationExpiresAt,
      invitedBy: invitedByUserId,
    });

    logger.info(
      { userId: user._id, email: normalizedEmail, invitedBy: invitedByUserId },
      'Invitation created'
    );

    await auditService.log({
      tenantId,
      userId: invitedByUserId,
      action: 'user.invited',
      resourceType: 'User',
      resourceId: user._id,
      newValues: {
        email: normalizedEmail,
        name,
        roleId: role._id,
        roleName: role.name,
        isActive: false,
        invitationExpiresAt,
      },
      auditContext: options.auditContext,
    });

    return {
      user: user.toJSON(),
      invitation: {
        token: invitationToken,
        expiresAt: invitationExpiresAt,
        acceptUrl: buildActionUrl('/accept-invite', invitationToken),
      },
    };
  }

  /**
   * Change a user's role.
   */
  async changeUserRole(targetUserId, tenantId, requestingUserId, { roleName }, options = {}) {
    // Cannot change own role
    if (String(targetUserId) === String(requestingUserId)) {
      throw new BadRequestError('Cannot change your own role');
    }

    const { role: requestingRole } = await this._getUserRoleContext(
      requestingUserId,
      tenantId
    );

    const targetUser = await User.findOne({ _id: targetUserId, tenantId });
    if (!targetUser) throw new NotFoundError('User not found');

    // Find new role
    const newRole = await Role.findOne({ tenantId, name: roleName });
    if (!newRole) throw new BadRequestError(`Role "${roleName}" not found`);

    const currentRole = await Role.findOne({ _id: targetUser.roleId, tenantId });
    if (!currentRole) throw new BadRequestError('Target user role not found');

    this._assertCanManageRole(requestingRole, currentRole, 'change roles for');
    this._assertCanAssignRole(requestingRole, newRole);

    // If demoting from owner, check there's at least one other owner
    if (currentRole && currentRole.name === 'owner' && roleName !== 'owner') {
      const ownerCount = await User.countDocuments({
        tenantId,
        roleId: currentRole._id,
        isActive: true,
      });
      if (ownerCount <= 1) {
        throw new BadRequestError('Cannot demote the last owner');
      }
    }

    targetUser.roleId = newRole._id;
    await targetUser.save();

    await auditService.log({
      tenantId,
      userId: requestingUserId,
      action: 'user.role_changed',
      resourceType: 'User',
      resourceId: targetUser._id,
      oldValues: {
        roleId: currentRole._id,
        roleName: currentRole.name,
      },
      newValues: {
        roleId: newRole._id,
        roleName: newRole.name,
      },
      auditContext: options.auditContext,
    });

    logger.info(
      { targetUserId, roleName, changedBy: requestingUserId },
      'User role changed'
    );

    return targetUser.toJSON();
  }

  /**
   * Deactivate a user.
   */
  async deactivateUser(targetUserId, tenantId, requestingUserId, options = {}) {
    if (String(targetUserId) === String(requestingUserId)) {
      throw new BadRequestError('Cannot deactivate yourself');
    }

    const { role: requestingRole } = await this._getUserRoleContext(
      requestingUserId,
      tenantId
    );

    const user = await User.findOne({ _id: targetUserId, tenantId });
    if (!user) throw new NotFoundError('User not found');

    const role = await Role.findOne({ _id: user.roleId, tenantId });
    if (!role) throw new BadRequestError('Target user role not found');

    this._assertCanManageRole(requestingRole, role, 'deactivate');

    // Cannot deactivate the last owner
    if (role && role.name === 'owner') {
      const ownerCount = await User.countDocuments({
        tenantId,
        roleId: role._id,
        isActive: true,
      });
      if (ownerCount <= 1) {
        throw new BadRequestError('Cannot deactivate the last owner');
      }
    }

    user.isActive = false;
    await user.save();

    await auditService.log({
      tenantId,
      userId: requestingUserId,
      action: 'user.deactivated',
      resourceType: 'User',
      resourceId: user._id,
      oldValues: {
        isActive: true,
        roleId: role._id,
        roleName: role.name,
      },
      newValues: {
        isActive: false,
        roleId: role._id,
        roleName: role.name,
      },
      auditContext: options.auditContext,
    });

    logger.info({ targetUserId, deactivatedBy: requestingUserId }, 'User deactivated');

    return user.toJSON();
  }

  /**
   * Update user profile.
   */
  async updateProfile(userId, tenantId, updates, options = {}) {
    const user = await User.findOne({ _id: userId, tenantId });
    if (!user) throw new NotFoundError('User not found');

    const oldValues = {
      name: user.name,
      language: user.language,
    };

    if (updates.name) user.name = updates.name;
    if (updates.language) user.language = updates.language;

    await user.save();

    await auditService.log({
      tenantId,
      userId,
      action: 'user.profile_updated',
      resourceType: 'User',
      resourceId: user._id,
      oldValues,
      newValues: {
        name: user.name,
        language: user.language,
      },
      auditContext: options.auditContext,
    });

    return user.toJSON();
  }

  async _getUserRoleContext(userId, tenantId) {
    const user = await User.findOne({ _id: userId, tenantId });
    if (!user) throw new NotFoundError('User not found');

    const role = await Role.findOne({ _id: user.roleId, tenantId });
    if (!role) throw new BadRequestError('User role not found');

    return { user, role };
  }

  _assertCanManageRole(requestingRole, targetRole, action) {
    const requestingRank = getRoleRank(requestingRole);
    const targetRank = getRoleRank(targetRole);

    if (!requestingRank || !targetRank) {
      throw new BadRequestError('Unsupported role hierarchy');
    }

    if (targetRank >= requestingRank) {
      throw new ForbiddenError(
        `You cannot ${action} users with the same or higher role`
      );
    }
  }

  _assertCanAssignRole(requestingRole, newRole) {
    const requestingRank = getRoleRank(requestingRole);
    const newRoleRank = getRoleRank(newRole);

    if (!requestingRank || !newRoleRank) {
      throw new BadRequestError('Unsupported role hierarchy');
    }

    if (newRoleRank >= requestingRank) {
      throw new ForbiddenError(
        'You cannot assign a role equal to or higher than your own'
      );
    }
  }
}

module.exports = new UserService();
