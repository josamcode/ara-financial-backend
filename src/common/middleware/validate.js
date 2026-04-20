'use strict';

const { ZodError } = require('zod');
const { ValidationError } = require('../errors');

/**
 * Creates an Express middleware that validates request data against a Zod schema.
 * @param {Object} schemas - { body?, query?, params? } each a Zod schema
 */
function validate(schemas) {
  return (req, _res, next) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        assignParsedValue(req, 'query', schemas.query.parse(req.query));
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params);
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const errors = err.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        return next(new ValidationError('Validation failed', errors));
      }
      next(err);
    }
  };
}

function assignParsedValue(req, key, parsedValue) {
  try {
    req[key] = parsedValue;
    return;
  } catch {
    // Express 5 exposes req.query via a getter, so mutate the backing object instead.
  }

  const target = req[key];
  if (target && typeof target === 'object') {
    for (const existingKey of Object.keys(target)) {
      delete target[existingKey];
    }

    Object.assign(target, parsedValue);
    return;
  }

  req[key] = parsedValue;
}

module.exports = validate;
