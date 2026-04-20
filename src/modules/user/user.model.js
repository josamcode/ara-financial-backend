'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const config = require('../../config');
const tenantPlugin = require('../../common/plugins/tenantPlugin');
const softDeletePlugin = require('../../common/plugins/softDeletePlugin');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true, // Global uniqueness — one email = one account
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false, // Never returned in queries by default
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    language: {
      type: String,
      enum: ['ar', 'en'],
      default: 'ar',
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
    },
    lockedUntil: {
      type: Date,
      default: null,
      select: false,
    },
    // For invited users who haven't accepted yet
    invitationToken: {
      type: String,
      default: null,
      select: false,
    },
    invitationExpiresAt: {
      type: Date,
      default: null,
    },
    passwordResetToken: {
      type: String,
      default: null,
      select: false,
    },
    passwordResetExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.invitationToken;
        delete ret.passwordResetToken;
        delete ret.passwordResetExpiresAt;
        delete ret.failedLoginAttempts;
        delete ret.lockedUntil;
        delete ret.__v;
        return ret;
      },
    },
  }
);

userSchema.plugin(tenantPlugin);
userSchema.plugin(softDeletePlugin);

userSchema.index({ tenantId: 1, email: 1 });
userSchema.index({ tenantId: 1, roleId: 1 });
userSchema.index({ invitationToken: 1 }, { sparse: true });
userSchema.index({ passwordResetToken: 1 }, { sparse: true });

/**
 * Hash password before saving.
 */
userSchema.pre('save', async function () {
  if (!this.isModified('passwordHash')) return;
  // passwordHash field actually receives plain password and gets hashed here
  this.passwordHash = await bcrypt.hash(this.passwordHash, config.bcrypt.rounds);
});

/**
 * Compare candidate password to stored hash.
 */
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

/**
 * Returns user data safe for JWT payload.
 */
userSchema.methods.toTokenPayload = function () {
  return {
    userId: this._id,
    tenantId: this.tenantId,
    roleId: this.roleId,
    email: this.email,
  };
};

const User = mongoose.model('User', userSchema);

module.exports = User;
