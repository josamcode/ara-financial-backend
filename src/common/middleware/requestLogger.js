'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../../config/logger');

/**
 * Assigns a unique request ID and logs incoming requests.
 */
function requestLogger(req, res, next) {
  req.id = req.headers['x-request-id'] || uuidv4();
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      requestId: req.id,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      userAgent: req.get('user-agent'),
      ip: req.ip,
    }, `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
}

module.exports = requestLogger;
