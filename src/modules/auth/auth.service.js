'use strict';

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../../config');
const { getRedisClient } = require('../../config/redis');
const logger = require('../../config/logger');
const User = require('../user/user.model');
const Tenant = require('../tenant/tenant.model');
const { Role, seedDefaultRoles, getEffectivePermissions } = require('./role.model');
const auditService = require('../audit/audit.service');
const {
  UnauthorizedError,
  ConflictError,
  NotFoundError,
  BadRequestError,
  TooManyRequestsError,
} = require('../../common/errors');

const REFRESH_TOKEN_PREFIX = 'rt:';
const RATE_LIMIT_PREFIX = 'rl:login:';
const PASSWORD_RESET_MESSAGE =
  'If an account exists for that email, password reset instructions have been issued.';

function normalizeEmail(email) {
  return email.trim().toLowerCase();
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

function isTransactionUnsupported(error) {
  const message = error?.message || '';
  return (
    error?.code === 20 ||
    message.includes('Transaction numbers are only allowed on a replica set member or mongos') ||
    message.includes('Transaction support is not enabled')
  );
}

class AuthService {
  /**
   * Register a new user + tenant.
   * Creates tenant, seeds default roles, creates owner user.
   */
  async register({ email, password, name, companyName, language }, options = {}) {
    const normalizedEmail = normalizeEmail(email);

    // Check for existing user
    const existingUser = await User.findOne({ email: normalizedEmail }).setOptions({
      __skipTenantFilter: true,
    });
    if (existingUser) {
      throw new ConflictError('Email already registered');
    }

    let registrationState;

    const session = await mongoose.startSession();

    try {
      try {
        await session.withTransaction(async () => {
          registrationState = await this._createRegistrationState(
            {
              normalizedEmail,
              password,
              name,
              companyName,
              language,
            },
            { session }
          );
        });
      } catch (error) {
        if (!isTransactionUnsupported(error)) {
          throw error;
        }

        registrationState = await this._createRegistrationStateWithCompensation({
          normalizedEmail,
          password,
          name,
          companyName,
          language,
        });
      }
    } catch (error) {
      if (error?.code === 11000) {
        throw new ConflictError('Email already registered');
      }

      throw error;
    } finally {
      await session.endSession();
    }

    const { tenant, roles, user } = registrationState;

    // Generate tokens
    const tokens = await this._generateTokens(user, roles.owner);

    await auditService.log({
      tenantId: tenant._id,
      userId: user._id,
      action: 'auth.registered',
      resourceType: 'User',
      resourceId: user._id,
      newValues: {
        email: user.email,
        name: user.name,
        tenantId: tenant._id,
      },
      auditContext: options.auditContext,
    });

    await auditService.log({
      tenantId: tenant._id,
      userId: user._id,
      action: 'tenant.created',
      resourceType: 'Tenant',
      resourceId: tenant._id,
      newValues: {
        name: tenant.name,
        language: tenant.settings.language,
      },
      auditContext: options.auditContext,
    });

    logger.info({ userId: user._id, tenantId: tenant._id }, 'New registration');

    return {
      user: user.toJSON(),
      tenant: tenant.toJSON(),
      ...tokens,
    };
  }

  /**
   * Authenticate user with email and password.
   */
  async login({ email, password }, ip, options = {}) {
    const normalizedEmail = normalizeEmail(email);
    const auditContext = this._buildAuditContext(options.auditContext, ip);
    const clientIp = auditContext.ip || 'unknown';

    // Check rate limit
    await this._checkLoginRateLimit(clientIp);

    // Find user with password and lockout fields
    const user = await User.findOne({ email: normalizedEmail })
      .select('+passwordHash +failedLoginAttempts +lockedUntil')
      .setOptions({ __skipTenantFilter: true });

    if (!user) {
      await this._incrementLoginAttempts(clientIp);
      logger.warn({ email: normalizedEmail, ip: clientIp }, 'Login failed for unknown account');
      throw new UnauthorizedError('Invalid credentials');
    }

    if (!user.isActive) {
      await this._incrementLoginAttempts(clientIp);
      await this._auditLoginEvent(user, 'auth.login_failed', auditContext, {
        reason: 'inactive_account',
      });
      throw new UnauthorizedError('Invalid credentials');
    }

    await this._clearExpiredLockout(user);

    const remainingLockSeconds = this._getRemainingLockSeconds(user);
    if (remainingLockSeconds > 0) {
      await this._incrementLoginAttempts(clientIp);
      await this._auditLoginEvent(user, 'auth.login_blocked', auditContext, {
        reason: 'account_locked',
        lockedUntil: user.lockedUntil,
      });
      throw new TooManyRequestsError(
        `Account is temporarily locked. Try again in ${remainingLockSeconds} seconds.`,
        remainingLockSeconds
      );
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      await this._incrementLoginAttempts(clientIp);

      const lockoutSeconds = await this._recordFailedLogin(user, auditContext);
      if (lockoutSeconds > 0) {
        throw new TooManyRequestsError(
          `Account is temporarily locked. Try again in ${lockoutSeconds} seconds.`,
          lockoutSeconds
        );
      }

      throw new UnauthorizedError('Invalid credentials');
    }

    // Get user's role
    const role = await Role.findOne({ _id: user.roleId, tenantId: user.tenantId });
    if (!role) {
      throw new UnauthorizedError('User role not found');
    }

    // Update login state
    user.lastLoginAt = new Date();
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await user.save();

    // Reset rate limit on success
    await this._resetLoginAttempts(clientIp);

    // Generate tokens
    const tokens = await this._generateTokens(user, role);

    await auditService.log({
      tenantId: user.tenantId,
      userId: user._id,
      action: 'auth.logged_in',
      resourceType: 'User',
      resourceId: user._id,
      newValues: {
        lastLoginAt: user.lastLoginAt,
      },
      auditContext,
    });

    logger.info({ userId: user._id }, 'User logged in');

    return {
      user: user.toJSON(),
      ...tokens,
    };
  }

  /**
   * Accept an invitation and activate the account.
   */
  async acceptInvite({ token, password, name, language }, options = {}) {
    const auditContext = this._buildAuditContext(options.auditContext);
    const user = await this._findUserByToken({
      token,
      tokenField: 'invitationToken',
      expiresField: 'invitationExpiresAt',
      errorMessage: 'Invitation token is invalid or expired',
      allowLegacyPlaintext: true,
    });

    if (user.isActive) {
      throw new BadRequestError('Invitation has already been accepted');
    }

    const role = await Role.findOne({ _id: user.roleId, tenantId: user.tenantId });
    if (!role) {
      throw new BadRequestError('User role not found');
    }

    user.passwordHash = password;
    if (name) user.name = name;
    if (language) user.language = language;
    user.isActive = true;
    user.emailVerified = true;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.invitationToken = null;
    user.invitationExpiresAt = null;
    user.passwordResetToken = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    const tokens = await this._generateTokens(user, role);

    await auditService.log({
      tenantId: user.tenantId,
      userId: user._id,
      action: 'auth.invite_accepted',
      resourceType: 'User',
      resourceId: user._id,
      newValues: {
        isActive: true,
        emailVerified: true,
        roleId: role._id,
        roleName: role.name,
      },
      auditContext,
    });

    logger.info({ userId: user._id, tenantId: user.tenantId }, 'Invitation accepted');

    return {
      user: user.toJSON(),
      ...tokens,
    };
  }

  /**
   * Create a password reset token for an active user.
   */
  async requestPasswordReset({ email }, options = {}) {
    const normalizedEmail = normalizeEmail(email);
    const auditContext = this._buildAuditContext(options.auditContext);
    const user = await User.findOne({ email: normalizedEmail })
      .select('+passwordResetToken +passwordResetExpiresAt')
      .setOptions({ __skipTenantFilter: true });

    if (!user || !user.isActive) {
      logger.info({ email: normalizedEmail }, 'Password reset requested for unavailable account');
      return { message: PASSWORD_RESET_MESSAGE };
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const passwordResetExpiresAt = new Date(
      Date.now() + (config.auth.passwordResetExpirySeconds * 1000)
    );

    user.passwordResetToken = this._hashOneTimeToken(resetToken);
    user.passwordResetExpiresAt = passwordResetExpiresAt;
    await user.save();

    await auditService.log({
      tenantId: user.tenantId,
      userId: user._id,
      action: 'auth.password_reset_requested',
      resourceType: 'User',
      resourceId: user._id,
      newValues: {
        passwordResetExpiresAt,
      },
      auditContext,
    });

    logger.info({ userId: user._id, tenantId: user.tenantId }, 'Password reset requested');

    return {
      message: PASSWORD_RESET_MESSAGE,
      passwordReset: {
        token: resetToken,
        expiresAt: passwordResetExpiresAt,
        resetUrl: buildActionUrl('/reset-password', resetToken),
      },
    };
  }

  /**
   * Reset password using a one-time token.
   */
  async resetPassword({ token, password }, options = {}) {
    const auditContext = this._buildAuditContext(options.auditContext);
    const user = await this._findUserByToken({
      token,
      tokenField: 'passwordResetToken',
      expiresField: 'passwordResetExpiresAt',
      errorMessage: 'Reset token is invalid or expired',
    });

    if (!user.isActive) {
      throw new BadRequestError('User account is inactive');
    }

    user.passwordHash = password;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.passwordResetToken = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    await this._revokeAllRefreshTokens(user._id.toString());

    await auditService.log({
      tenantId: user.tenantId,
      userId: user._id,
      action: 'auth.password_reset_completed',
      resourceType: 'User',
      resourceId: user._id,
      newValues: {
        passwordResetAt: new Date(),
      },
      auditContext,
    });

    logger.info({ userId: user._id, tenantId: user.tenantId }, 'Password reset completed');

    return { message: 'Password reset successfully' };
  }

  /**
   * Refresh access token using a valid refresh token.
   */
  async refresh(refreshToken, options = {}) {
    const redis = getRedisClient();

    // Verify the refresh token JWT
    let payload;
    try {
      payload = jwt.verify(refreshToken, config.jwt.secret);
    } catch {
      throw new UnauthorizedError('Invalid refresh token');
    }

    // Check if refresh token exists in Redis
    const tokenKey = `${REFRESH_TOKEN_PREFIX}${payload.userId}:${this._hashRefreshToken(refreshToken)}`;
    const exists = await redis.exists(tokenKey);
    if (!exists) {
      throw new UnauthorizedError('Refresh token revoked or expired');
    }

    // Revoke old refresh token
    await redis.del(tokenKey);

    // Get user and role
    const user = await User.findById(payload.userId).setOptions({ __skipTenantFilter: true });
    if (!user || !user.isActive) {
      throw new UnauthorizedError('User not found or inactive');
    }

    const role = await Role.findOne({ _id: user.roleId, tenantId: user.tenantId });
    if (!role) {
      throw new UnauthorizedError('User role not found');
    }

    // Generate new token pair
    const tokens = await this._generateTokens(user, role);

    await auditService.log({
      tenantId: user.tenantId,
      userId: user._id,
      action: 'auth.token_refreshed',
      resourceType: 'User',
      resourceId: user._id,
      auditContext: options.auditContext,
    });

    return tokens;
  }

  /**
   * Logout - revoke refresh token.
   */
  async logout(userId, refreshToken, options = {}) {
    const redis = getRedisClient();
    if (refreshToken) {
      const tokenKey = `${REFRESH_TOKEN_PREFIX}${userId}:${this._hashRefreshToken(refreshToken)}`;
      await redis.del(tokenKey);
    }

    const user = await User.findById(userId)
      .select('tenantId')
      .setOptions({ __skipTenantFilter: true });

    if (user) {
      await auditService.log({
        tenantId: user.tenantId,
        userId,
        action: 'auth.logged_out',
        resourceType: 'User',
        resourceId: userId,
        auditContext: options.auditContext,
      });
    }

    logger.info({ userId }, 'User logged out');
  }

  /**
   * Get the current authenticated user with role info.
   */
  async getCurrentUser(userId, tenantId) {
    const user = await User.findOne({ _id: userId, tenantId })
      .populate({
        path: 'roleId',
        select: 'name label permissions isSystem',
        match: { tenantId },
      });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    const payload = user.toJSON();
    if (payload.roleId) {
      payload.roleId.permissions = getEffectivePermissions(user.roleId);
    }

    return payload;
  }

  async _generateTokens(user, role) {
    const effectivePermissions = getEffectivePermissions(role);
    const tokenPayload = {
      userId: user._id.toString(),
      tenantId: user.tenantId.toString(),
      roleId: role._id.toString(),
      roleName: role.name,
      permissions: effectivePermissions,
    };

    const accessToken = jwt.sign(tokenPayload, config.jwt.secret, {
      expiresIn: config.jwt.accessExpiry,
    });

    const refreshToken = jwt.sign(
      { userId: user._id.toString(), type: 'refresh' },
      config.jwt.secret,
      { expiresIn: config.jwt.refreshExpiry }
    );

    // Store refresh token in Redis
    const redis = getRedisClient();
    const tokenKey = `${REFRESH_TOKEN_PREFIX}${user._id}:${this._hashRefreshToken(refreshToken)}`;
    await redis.setex(
      tokenKey,
      config.jwt.refreshExpirySeconds,
      JSON.stringify({
        userId: user._id.toString(),
        tenantId: user.tenantId.toString(),
        createdAt: new Date().toISOString(),
      })
    );

    return { accessToken, refreshToken };
  }

  async _createRegistrationState(
    { normalizedEmail, password, name, companyName, language },
    options = {}
  ) {
    const tenant = new Tenant({
      name: companyName,
      settings: { language: language || 'ar' },
    });
    await tenant.save(options.session ? { session: options.session } : undefined);

    const roles = await seedDefaultRoles(tenant._id, {
      session: options.session,
    });

    const user = new User({
      email: normalizedEmail,
      passwordHash: password, // Pre-save hook will hash it
      name,
      tenantId: tenant._id,
      roleId: roles.owner._id,
      language: language || 'ar',
    });
    await user.save(options.session ? { session: options.session } : undefined);

    return { tenant, roles, user };
  }

  async _createRegistrationStateWithCompensation(payload) {
    let tenant = null;
    let roles = null;
    let user = null;

    try {
      tenant = new Tenant({
        name: payload.companyName,
        settings: { language: payload.language || 'ar' },
      });
      await tenant.save();

      roles = await seedDefaultRoles(tenant._id);

      user = new User({
        email: payload.normalizedEmail,
        passwordHash: payload.password,
        name: payload.name,
        tenantId: tenant._id,
        roleId: roles.owner._id,
        language: payload.language || 'ar',
      });
      await user.save();

      return { tenant, roles, user };
    } catch (error) {
      await this._cleanupPartialRegistration(tenant?._id);
      throw error;
    }
  }

  async _cleanupPartialRegistration(tenantId) {
    if (!tenantId) {
      return;
    }

    try {
      await User.deleteMany({ tenantId });
      await Role.deleteMany({ tenantId });
      await Tenant.deleteOne({ _id: tenantId });
    } catch (cleanupError) {
      logger.error(
        { err: cleanupError, tenantId },
        'Failed to clean up partial registration state'
      );
    }
  }

  _buildAuditContext(auditContext = {}, ip) {
    return {
      ...auditContext,
      ip: auditContext.ip || ip || null,
    };
  }

  _hashRefreshToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex').substring(0, 16);
  }

  _hashOneTimeToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  _getRemainingLockSeconds(user) {
    if (!user.lockedUntil) {
      return 0;
    }

    const remainingMs = user.lockedUntil.getTime() - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }

  async _clearExpiredLockout(user) {
    if (!user.lockedUntil || user.lockedUntil.getTime() > Date.now()) {
      return;
    }

    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await user.save();
  }

  async _recordFailedLogin(user, auditContext) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;

    let action = 'auth.login_failed';
    if (user.failedLoginAttempts >= config.auth.accountLockoutAttempts) {
      user.lockedUntil = new Date(Date.now() + (config.auth.accountLockoutSeconds * 1000));
      action = 'auth.login_locked';
    }

    await user.save();

    await this._auditLoginEvent(user, action, auditContext, {
      reason: 'invalid_credentials',
      failedLoginAttempts: user.failedLoginAttempts,
      lockedUntil: user.lockedUntil,
    });

    return this._getRemainingLockSeconds(user);
  }

  async _auditLoginEvent(user, action, auditContext, newValues = {}) {
    await auditService.log({
      tenantId: user.tenantId,
      userId: user._id,
      action,
      resourceType: 'User',
      resourceId: user._id,
      newValues,
      auditContext,
    });
  }

  async _findUserByToken({
    token,
    tokenField,
    expiresField,
    errorMessage,
    allowLegacyPlaintext = false,
  }) {
    const tokenValues = [this._hashOneTimeToken(token)];
    if (allowLegacyPlaintext) {
      tokenValues.push(token);
    }

    const selectFields = [`+${tokenField}`, '+failedLoginAttempts', '+lockedUntil'];
    if (expiresField === 'passwordResetExpiresAt') {
      selectFields.push('+passwordResetExpiresAt');
    }

    const user = await User.findOne({
      [tokenField]: { $in: tokenValues },
      [expiresField]: { $gt: new Date() },
    })
      .select(selectFields.join(' '))
      .setOptions({ __skipTenantFilter: true });

    if (!user) {
      throw new BadRequestError(errorMessage);
    }

    return user;
  }

  async _revokeAllRefreshTokens(userId) {
    const redis = getRedisClient();
    let cursor = '0';
    const pattern = `${REFRESH_TOKEN_PREFIX}${userId}:*`;

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  }

  async _checkLoginRateLimit(ip) {
    const redis = getRedisClient();
    const key = `${RATE_LIMIT_PREFIX}${ip}`;
    const attempts = await redis.get(key);

    if (attempts && parseInt(attempts, 10) >= config.rateLimit.loginMax) {
      const ttl = await redis.ttl(key);
      throw new TooManyRequestsError(
        `Too many login attempts. Try again in ${ttl} seconds.`,
        ttl
      );
    }
  }

  async _incrementLoginAttempts(ip) {
    const redis = getRedisClient();
    const key = `${RATE_LIMIT_PREFIX}${ip}`;
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, config.rateLimit.loginWindowSeconds);
    }
  }

  async _resetLoginAttempts(ip) {
    const redis = getRedisClient();
    const key = `${RATE_LIMIT_PREFIX}${ip}`;
    await redis.del(key);
  }
}

module.exports = new AuthService();
