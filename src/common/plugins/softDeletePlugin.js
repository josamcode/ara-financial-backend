'use strict';

/**
 * Mongoose plugin that adds soft delete functionality.
 * Adds a `deletedAt` field and overrides find queries to
 * exclude soft-deleted documents by default.
 */
function softDeletePlugin(schema) {
  schema.add({
    deletedAt: { type: Date, default: null },
  });

  // Index for efficient queries filtering deleted records
  schema.index({ deletedAt: 1 });

  // Override default find to exclude soft-deleted
  schema.pre(/^find/, function () {
    if (this.getOptions().__includeDeleted) return;
    const filter = this.getFilter();
    if (filter.deletedAt === undefined) {
      this.where({ deletedAt: null });
    }
  });

  // Soft delete method on documents
  schema.methods.softDelete = function () {
    this.deletedAt = new Date();
    return this.save();
  };

  // Restore method
  schema.methods.restore = function () {
    this.deletedAt = null;
    return this.save();
  };

  // Static soft delete by query
  schema.statics.softDeleteMany = function (filter) {
    return this.updateMany(filter, { deletedAt: new Date() });
  };

  // Static to find including deleted
  schema.statics.findWithDeleted = function (filter) {
    return this.find(filter).setOptions({ __includeDeleted: true });
  };

  schema.statics.findOneWithDeleted = function (filter) {
    return this.findOne(filter).setOptions({ __includeDeleted: true });
  };
}

module.exports = softDeletePlugin;
