'use strict';

/**
 * Wraps async route handlers to catch errors and forward them
 * to the global error handler via next().
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
