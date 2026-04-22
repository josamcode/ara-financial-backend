'use strict';

const logger = require('../../config/logger');

function buildValidationMessage(errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return 'Validation failed';
  }

  return errors
    .map(({ field, message }) => (field ? `${field}: ${message}` : message))
    .join('; ');
}

function toFieldLabel(field) {
  if (!field) return 'Field';

  return String(field)
    .replace(/[_.-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Global error handling middleware.
 * Catches all errors and returns a standardized response.
 * Never leaks internal error details in production.
 */
function errorHandler(err, req, res, _next) {
  // Default values
  let statusCode = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'Something went wrong';
  let errors = err.errors || undefined;

  // Mongoose validation error
  if (err.name === 'ValidationError' && err.errors && !err.isOperational) {
    statusCode = 422;
    code = 'VALIDATION_ERROR';
    errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    message = buildValidationMessage(errors);
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    statusCode = 400;
    code = 'BAD_REQUEST';
    const field = Object.keys(err.keyPattern || {})[0] || 'unknown';
    const fieldLabel = toFieldLabel(field);
    message = `${fieldLabel} already exists`;
    errors = [{ field, message }];
  }

  // Mongoose cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    statusCode = 400;
    code = 'BAD_REQUEST';
    message = `Invalid ${toFieldLabel(err.path)}`;
    errors = [{ field: err.path, message }];
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    code = 'UNAUTHORIZED';
    message = 'Invalid token';
  }
  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    code = 'UNAUTHORIZED';
    message = 'Token expired';
  }

  // Log error
  if (statusCode >= 500) {
    logger.error({ err, requestId: req.id }, 'Unhandled error');
  } else {
    logger.warn({ err, statusCode, code, message, requestId: req.id }, 'Client error');
  }

  if (statusCode >= 500) {
    statusCode = 500;
    code = 'INTERNAL_ERROR';
    message = 'Something went wrong';
    errors = undefined;
  }

  const response = {
    success: false,
    error: {
      code,
      message,
    },
  };

  if (errors) {
    response.error.errors = errors;
  }

  if (err.retryAfter) {
    res.setHeader('Retry-After', err.retryAfter);
  }

  return res.status(statusCode).json(response);
}

module.exports = errorHandler;
