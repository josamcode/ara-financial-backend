'use strict';

const mongoose = require('mongoose');
const tenantPlugin = require('../../common/plugins/tenantPlugin');

const IMMUTABLE_AUDIT_ERROR = 'Audit logs are immutable and cannot be updated or deleted';

function immutableAuditError() {
  return new Error(IMMUTABLE_AUDIT_ERROR);
}

function throwImmutableAuditError() {
  throw immutableAuditError();
}

/**
 * Immutable audit log.
 * Stored in a separate collection. No update or delete operations allowed.
 */
const auditLogSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    resourceType: {
      type: String,
      required: true,
    },
    resourceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    oldValues: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    newValues: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    ip: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // Immutable — no updates
  }
);

auditLogSchema.plugin(tenantPlugin);

auditLogSchema.pre('save', function () {
  if (this.isNew) {
    return;
  }

  throw immutableAuditError();
});

for (const hook of [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
]) {
  auditLogSchema.pre(hook, function () {
    throw immutableAuditError();
  });
}

auditLogSchema.pre('updateOne', { document: true, query: false }, function () {
  throw immutableAuditError();
});

for (const hook of ['deleteMany', 'findOneAndDelete', 'findOneAndRemove']) {
  auditLogSchema.pre(hook, function () {
    throw immutableAuditError();
  });
}

auditLogSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw immutableAuditError();
});

auditLogSchema.pre('deleteOne', { document: false, query: true }, function () {
  throw immutableAuditError();
});

for (const method of [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findOneAndRemove',
]) {
  auditLogSchema.statics[method] = throwImmutableAuditError;
}

auditLogSchema.methods.updateOne = throwImmutableAuditError;
auditLogSchema.methods.deleteOne = throwImmutableAuditError;

// Compound indexes for efficient querying
auditLogSchema.index({ tenantId: 1, createdAt: -1 });
auditLogSchema.index({ tenantId: 1, resourceType: 1, resourceId: 1 });
auditLogSchema.index({ tenantId: 1, userId: 1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
