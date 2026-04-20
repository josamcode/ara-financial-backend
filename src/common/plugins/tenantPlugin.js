'use strict';

const mongoose = require('mongoose');

function hasTenantFilter(filter) {
  return Boolean(
    filter &&
    Object.prototype.hasOwnProperty.call(filter, 'tenantId')
  );
}

function createTenantContextError(operation) {
  const error = new Error(`Tenant context is required for ${operation} queries`);
  error.code = 'TENANT_CONTEXT_REQUIRED';
  return error;
}

/**
 * Mongoose plugin that adds tenant_id to every schema and enforces
 * automatic tenant filtering on all find/count/update/delete operations.
 *
 * This is the primary mechanism for tenant isolation. Every query
 * automatically includes a tenant_id filter, making cross-tenant
 * data leakage impossible at the ORM level.
 */
function tenantPlugin(schema) {
  // Add tenant_id field
  schema.add({
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
  });

  // Pre-save: ensure tenantId is set
  schema.pre('save', function () {
    if (!this.tenantId) {
      throw new Error('tenantId is required');
    }
  });

  // Auto-filter all find queries
  const queryHooks = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'countDocuments',
    'estimatedDocumentCount',
    'updateOne',
    'updateMany',
    'deleteOne',
    'deleteMany',
  ];

  for (const hook of queryHooks) {
    schema.pre(hook, function () {
      const options = this.getOptions();
      if (options.__skipTenantFilter) return;

      const filter = this.getFilter();
      if (hasTenantFilter(filter)) return;

      const tenantId = options._tenantId || this._tenantId;
      if (tenantId) {
        this.where({ tenantId });
        return;
      }

      throw createTenantContextError(hook);
    });
  }

  // Auto-filter aggregation pipelines
  schema.pre('aggregate', function () {
    const pipeline = this.pipeline();
    if (this.options.__skipTenantFilter) return;

    const hasMatchStage = pipeline.some(
      (stage) => stage.$match && hasTenantFilter(stage.$match)
    );

    if (hasMatchStage) return;

    if (this.options._tenantId) {
      pipeline.unshift({
        $match: { tenantId: new mongoose.Types.ObjectId(this.options._tenantId) },
      });
      return;
    }

    throw createTenantContextError('aggregate');
  });

  // Static helper to scope queries to a tenant
  schema.statics.byTenant = function (tenantId) {
    const query = this.find();
    query.setOptions({ _tenantId: tenantId });
    query._tenantId = tenantId;
    return query;
  };
}

module.exports = tenantPlugin;
