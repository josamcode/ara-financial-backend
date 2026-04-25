'use strict';

const dotenv = require('dotenv');
const path = require('path');

// Load environment from the backend root. Tests use .env.test so they never
// silently inherit local development or production-like database settings.
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(__dirname, `../../${envFile}`), quiet: true });

/**
 * Validates that all required environment variables are set.
 * Fails fast at startup if anything is missing.
 */
function validateEnv(requiredVars) {
  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }
}

validateEnv(['MONGODB_URI', 'JWT_SECRET']);

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,

  db: {
    uri: process.env.MONGODB_URI,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
    refreshExpirySeconds: parseDurationToSeconds(
      process.env.JWT_REFRESH_EXPIRY || '7d'
    ),
  },

  bcrypt: {
    rounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,
  },

  auth: {
    invitationExpirySeconds: parseDurationToSeconds(
      process.env.INVITATION_EXPIRY || '7d'
    ),
    passwordResetExpirySeconds: parseDurationToSeconds(
      process.env.PASSWORD_RESET_EXPIRY || '1h'
    ),
    accountLockoutAttempts:
      parseInt(process.env.ACCOUNT_LOCKOUT_ATTEMPTS, 10) || 5,
    accountLockoutSeconds: parseDurationToSeconds(
      process.env.ACCOUNT_LOCKOUT_DURATION || '15m'
    ),
    exposeEmailActionTokens: process.env.EXPOSE_EMAIL_ACTION_TOKENS === 'true',
  },

  rateLimit: {
    loginMax: parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 5,
    loginWindowSeconds:
      parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS, 10) || 60,
  },

  http: {
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV),
  },

  cors: {
    allowedOrigins: parseCsv(process.env.CORS_ORIGINS),
  },

  urls: {
    appBaseUrl: process.env.APP_BASE_URL || process.env.FRONTEND_URL || null,
  },

  smtp: {
    host: process.env.SMTP_HOST || null,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
    from: process.env.SMTP_FROM || null,
  },

  report: {
    cacheTtlSeconds: parseInt(process.env.REPORT_CACHE_TTL_SECONDS, 10) || 60,
  },

  logging: {
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  },
};

/**
 * Parses duration strings like '15m', '7d', '1h' to seconds.
 */
function parseDurationToSeconds(duration) {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 604800; // default 7 days
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (multipliers[unit] || 1);
}

function parseCsv(value) {
  if (!value) return [];

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTrustProxy(value, env) {
  if (value === undefined || value === null || value === '') {
    return env === 'production' ? 1 : false;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (normalized === 'loopback') return 'loopback';
  if (normalized === 'linklocal') return 'linklocal';
  if (normalized === 'uniquelocal') return 'uniquelocal';

  const numericValue = Number(normalized);
  if (!Number.isNaN(numericValue)) {
    return numericValue;
  }

  return value;
}

module.exports = config;
