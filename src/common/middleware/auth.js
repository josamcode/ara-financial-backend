'use strict';

const jwt = require('jsonwebtoken');
const config = require('../../config');
const { UnauthorizedError, ForbiddenError } = require('../../common/errors');
const User = require('../../modules/user/user.model');
const { getEffectivePermissions } = require('../../modules/auth/role.model');

/**
 * Authenticates the request by verifying the JWT access token.
 * Attaches the current persisted user/role context to req.user.
 */
function authenticate(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Access token required'));
  }

  const token = authHeader.split(' ')[1];
  let decoded;

  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new UnauthorizedError('Token expired'));
    }
    return next(new UnauthorizedError('Invalid token'));
  }

  if (!decoded.userId || !decoded.tenantId) {
    return next(new UnauthorizedError('Invalid token'));
  }

  Promise.resolve()
    .then(async () => {
      const user = await User.findOne({
        _id: decoded.userId,
        tenantId: decoded.tenantId,
        isActive: true,
      }).populate({
        path: 'roleId',
        select: 'name permissions isSystem',
        match: { tenantId: decoded.tenantId },
      });

      if (!user) {
        throw new UnauthorizedError('User account is inactive or no longer available');
      }

      if (!user.roleId) {
        throw new UnauthorizedError('User role is no longer available');
      }

      req.user = {
        userId: user._id.toString(),
        tenantId: user.tenantId.toString(),
        roleId: user.roleId._id.toString(),
        roleName: user.roleId.name,
        permissions: getEffectivePermissions(user.roleId),
      };
    })
    .then(() => next())
    .catch(next);
}

/**
 * Authorization middleware factory.
 * Checks if the user has the required permission(s).
 * @param  {...string} requiredPermissions - One or more resource:action strings
 */
function authorize(...requiredPermissions) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    const userPermissions = req.user.permissions || [];
    const hasPermission = requiredPermissions.every((p) =>
      userPermissions.includes(p)
    );

    if (!hasPermission) {
      return next(
        new ForbiddenError('You do not have permission to perform this action')
      );
    }

    next();
  };
}

/**
 * Injects tenantId into the request context for downstream use.
 * Must be used after authenticate middleware.
 */
function tenantContext(req, _res, next) {
  if (!req.user || !req.user.tenantId) {
    return next(new UnauthorizedError('Tenant context required'));
  }
  req.tenantId = req.user.tenantId;
  next();
}

module.exports = { authenticate, authorize, tenantContext };
