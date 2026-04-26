'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const DEFAULT_SAFE_TEST_MONGODB_URI = 'mongodb://localhost:27017/ara_financial_test';
const SAFE_DB_NAME_PATTERN = /(^|[^a-z0-9])(test|testing|dev|development|ci)([^a-z0-9]|$)/i;
const SAFE_HOST_NAME_PATTERN = /(^|[._-])(test|testing|dev|development|ci)([._-]|$)/i;
const PRODUCTION_NAME_PATTERN = /(^|[^a-z0-9])(prod|production|live)([^a-z0-9]|$)/i;
const PRODUCTION_HOST_PATTERN = /(^|[._-])(prod|production|live)([._-]|$)/i;

class SafeTestEnvironmentError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'SafeTestEnvironmentError';
    this.errors = errors;
  }
}

function configureSafeTestEnvironment(options = {}) {
  const backendRoot = options.backendRoot || path.resolve(__dirname, '..');
  const testEnvPath = options.testEnvPath || path.join(backendRoot, '.env.test');

  if (fs.existsSync(testEnvPath)) {
    dotenv.config({ path: testEnvPath, override: true, quiet: true });
  }

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = process.env.MONGODB_URI || DEFAULT_SAFE_TEST_MONGODB_URI;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/1';
  process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '4';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

  assertSafeTestEnvironment(process.env);

  return {
    mongoUri: process.env.MONGODB_URI,
    testEnvPath,
    usedTestEnvFile: fs.existsSync(testEnvPath),
  };
}

function assertSafeTestEnvironment(env) {
  const errors = getSafeTestEnvironmentErrors(env);

  if (errors.length > 0) {
    throw new SafeTestEnvironmentError(errors);
  }
}

function assertSafeMongoTestUri(mongoUri) {
  const errors = getSafeMongoUriErrors(mongoUri);

  if (errors.length > 0) {
    throw new SafeTestEnvironmentError(errors);
  }
}

function getSafeTestEnvironmentErrors(env) {
  const errors = [];

  if (env.NODE_ENV !== 'test') {
    errors.push(`NODE_ENV must be "test" for tests. Received "${env.NODE_ENV || '<empty>'}".`);
  }

  errors.push(...getSafeMongoUriErrors(env.MONGODB_URI));
  return errors;
}

function getSafeMongoUriErrors(mongoUri) {
  const errors = [];

  if (!mongoUri) {
    errors.push(
      'MONGODB_URI is required for backend verification. Use mongodb://localhost:27017/ara_financial_test.'
    );
    return errors;
  }

  const mongoInfo = parseMongoUri(mongoUri);
  const normalizedDbName = (mongoInfo.dbName || '').toLowerCase();

  if (!/^mongodb(\+srv)?:\/\//i.test(mongoUri)) {
    errors.push('MONGODB_URI must start with mongodb:// for local or CI tests.');
  }

  if (mongoInfo.protocol === 'mongodb+srv:') {
    errors.push('MONGODB_URI must not use mongodb+srv for tests.');
  }

  if (mongoInfo.hosts.some((host) => host.includes('mongodb.net'))) {
    errors.push('MONGODB_URI must not point tests at an Atlas host.');
  }

  if (mongoInfo.hosts.some((host) => PRODUCTION_HOST_PATTERN.test(host))) {
    errors.push(`MONGODB_URI host looks production-like: "${mongoInfo.hosts.join(', ')}".`);
  }

  const unsafeHosts = mongoInfo.hosts.filter((host) => !isSafeTestHost(host));
  if (unsafeHosts.length > 0) {
    errors.push(
      `MONGODB_URI host must be local or clearly test/dev/ci. Received "${unsafeHosts.join(', ')}".`
    );
  }

  if (!mongoInfo.dbName) {
    errors.push('MONGODB_URI must include an explicit test database name.');
  } else if (!SAFE_DB_NAME_PATTERN.test(normalizedDbName)) {
    errors.push(
      `MongoDB test database name must clearly contain test, dev, or ci. Received "${mongoInfo.dbName}".`
    );
  }

  if (PRODUCTION_NAME_PATTERN.test(normalizedDbName)) {
    errors.push(`MongoDB database name looks production-like: "${mongoInfo.dbName}".`);
  }

  return errors;
}

function isSafeTestHost(host) {
  if (
    host === 'localhost' ||
    host === 'host.docker.internal' ||
    host === 'mongo' ||
    host === 'mongodb' ||
    host === '::1'
  ) {
    return true;
  }

  if (/^127(?:\.\d{1,3}){3}$/.test(host)) {
    return true;
  }

  return SAFE_HOST_NAME_PATTERN.test(host);
}

function printSafeTestEnvironmentError(error) {
  const errors = error instanceof SafeTestEnvironmentError
    ? error.errors
    : [error.message || String(error)];

  console.error('Safe test environment check failed:');
  for (const message of errors) {
    console.error(`- ${message}`);
  }
  console.error('Refusing to run backend verification against an unsafe database.');
}

function parseMongoUri(uri) {
  const info = {
    protocol: null,
    hosts: [],
    dbName: '',
  };

  try {
    const parsed = new URL(uri);
    info.protocol = parsed.protocol.toLowerCase();
    info.hosts = parseHosts(parsed.host);
    info.dbName = decodeURIComponent(
      parsed.searchParams.get('dbName') || parsed.pathname.replace(/^\/+/, '').split('/')[0] || ''
    );
    return info;
  } catch {
    return parseMongoUriFallback(uri, info);
  }
}

function parseMongoUriFallback(uri, info) {
  const query = uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : '';
  const dbNameParam = new URLSearchParams(query).get('dbName');
  const withoutProtocol = uri.replace(/^mongodb(\+srv)?:\/\//i, '');
  const withoutQuery = withoutProtocol.split(/[?#]/)[0];
  const withoutCredentials = withoutQuery.includes('@')
    ? withoutQuery.slice(withoutQuery.lastIndexOf('@') + 1)
    : withoutQuery;
  const slashIndex = withoutCredentials.indexOf('/');
  const hostPart = slashIndex >= 0 ? withoutCredentials.slice(0, slashIndex) : withoutCredentials;
  const pathPart = slashIndex >= 0 ? withoutCredentials.slice(slashIndex + 1) : '';

  info.protocol = uri.toLowerCase().startsWith('mongodb+srv://') ? 'mongodb+srv:' : 'mongodb:';
  info.hosts = parseHosts(hostPart);
  info.dbName = decodeURIComponent(dbNameParam || pathPart.split('/')[0] || '');
  return info;
}

function parseHosts(hostPart) {
  return hostPart
    .split(',')
    .map((host) => normalizeHost(host))
    .filter(Boolean);
}

function normalizeHost(rawHost) {
  const host = rawHost.trim().toLowerCase();

  if (host.startsWith('[')) {
    const closingBracketIndex = host.indexOf(']');
    return closingBracketIndex >= 0 ? host.slice(1, closingBracketIndex) : host;
  }

  return host.split(':')[0];
}

module.exports = {
  DEFAULT_SAFE_TEST_MONGODB_URI,
  SafeTestEnvironmentError,
  assertSafeMongoTestUri,
  assertSafeTestEnvironment,
  configureSafeTestEnvironment,
  getSafeMongoUriErrors,
  getSafeTestEnvironmentErrors,
  isSafeTestHost,
  parseMongoUri,
  printSafeTestEnvironmentError,
};
