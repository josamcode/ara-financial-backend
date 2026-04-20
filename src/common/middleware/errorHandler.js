'use strict';

const logger = require('../../config/logger');
const { AppError } = require('../errors');

/**
 * Global error handling middleware.
 * Catches all errors and returns a standardized response.
 * Never leaks internal error details in production.
 */
function errorHandler(err, req, res, _next) {
  // Default values
  let statusCode = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'An unexpected error occurred';
  let errors = err.errors || undefined;

  // Mongoose validation error
  if (err.name === 'ValidationError' && err.errors && !err.isOperational) {
    statusCode = 422;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    statusCode = 409;
    code = 'DUPLICATE_KEY';
    const field = Object.keys(err.keyPattern || {})[0] || 'unknown';
    message = `Duplicate value for field: ${field}`;
  }

  // Mongoose cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    statusCode = 400;
    code = 'INVALID_ID';
    message = `Invalid value for ${err.path}: ${err.value}`;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    code = 'INVALID_TOKEN';
    message = 'Invalid token';
  }
  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    code = 'TOKEN_EXPIRED';
    message = 'Token expired';
  }

  // Log error
  if (statusCode >= 500) {
    logger.error({ err, requestId: req.id }, 'Unhandled error');
  } else {
    logger.warn({ statusCode, code, message, requestId: req.id }, 'Client error');
  }

  // Do not leak internals in production
  const isProduction = process.env.NODE_ENV === 'production';
  const response = {
    success: false,
    error: {
      code,
      message: isProduction && statusCode >= 500 ? 'An unexpected error occurred' : message,
    },
  };

  if (errors) {
    response.error.errors = errors;
  }

  if (!isProduction && err.stack) {
    response.error.stack = err.stack;
  }

  if (err.retryAfter) {
    res.setHeader('Retry-After', err.retryAfter);
  }

  return res.status(statusCode).json(response);
}

module.exports = errorHandler;
