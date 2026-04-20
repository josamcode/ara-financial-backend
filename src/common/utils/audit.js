'use strict';

function getAuditContext(req) {
  const userAgent =
    req && typeof req.get === 'function'
      ? req.get('user-agent')
      : req?.headers?.['user-agent'];

  return {
    ip: req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || null,
    userAgent: userAgent || null,
  };
}

module.exports = {
  getAuditContext,
};
