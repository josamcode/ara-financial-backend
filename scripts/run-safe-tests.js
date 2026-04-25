'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const backendRoot = path.resolve(__dirname, '..');
const testEnvPath = path.join(backendRoot, '.env.test');

if (fs.existsSync(testEnvPath)) {
  dotenv.config({ path: testEnvPath, override: true, quiet: true });
}

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/1';
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '4';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

assertSafeTestEnvironment(process.env);

const testDir = path.join(backendRoot, 'test');
const testFiles = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => path.join('test', file));

if (testFiles.length === 0) {
  console.error('No backend test files found in test/*.test.js');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...testFiles],
  {
    cwd: backendRoot,
    env: process.env,
    stdio: 'inherit',
  }
);

process.exit(result.status === null ? 1 : result.status);

function assertSafeTestEnvironment(env) {
  const errors = [];
  const mongoUri = env.MONGODB_URI;

  if (env.NODE_ENV !== 'test') {
    errors.push(`NODE_ENV must be "test" for tests. Received "${env.NODE_ENV || '<empty>'}".`);
  }

  if (!mongoUri) {
    errors.push('MONGODB_URI is required for tests. Create backend/.env.test from .env.test.example or set it in CI.');
  } else {
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

    if (mongoInfo.hosts.some((host) => /(^|[.-])(prod|production|live)([.-]|$)/.test(host))) {
      errors.push(`MONGODB_URI host looks production-like: "${mongoInfo.hosts.join(', ')}".`);
    }

    if (!mongoInfo.dbName) {
      errors.push('MONGODB_URI must include an explicit test database name.');
    } else if (!/(^|[_-])(test|testing|ci)($|[_-])/.test(normalizedDbName)) {
      errors.push(
        `MongoDB test database name must contain "test" or "ci". Received "${mongoInfo.dbName}".`
      );
    }

    if (/(^|[_-])(prod|production|live)($|[_-])/.test(normalizedDbName)) {
      errors.push(`MongoDB database name looks production-like: "${mongoInfo.dbName}".`);
    }
  }

  if (errors.length > 0) {
    console.error('Safe test environment check failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    console.error('Refusing to run backend tests.');
    process.exit(1);
  }
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
    .map((host) => host.trim().replace(/^\[/, '').replace(/\]$/, '').split(':')[0].toLowerCase())
    .filter(Boolean);
}
