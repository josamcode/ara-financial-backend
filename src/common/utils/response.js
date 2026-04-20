'use strict';

/**
 * Standardized API response format.
 * Every response follows: { success, data, error, meta }
 */

function success(res, data = null, meta = null, statusCode = 200) {
  const response = { success: true, data };
  if (meta) response.meta = meta;
  return res.status(statusCode).json(response);
}

function created(res, data = null, meta = null) {
  return success(res, data, meta, 201);
}

function noContent(res) {
  return res.status(204).end();
}

function paginated(res, data, pagination) {
  return success(res, data, { pagination });
}

/**
 * Build pagination meta from query params and total count.
 */
function buildPaginationMeta(page, limit, total) {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

/**
 * Parse pagination params from query with defaults.
 */
function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

module.exports = {
  success,
  created,
  noContent,
  paginated,
  buildPaginationMeta,
  parsePagination,
};
