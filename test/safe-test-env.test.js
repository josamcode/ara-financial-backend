'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertSafeMongoTestUri,
  getSafeMongoUriErrors,
  getSafeTestEnvironmentErrors,
} = require('../scripts/safe-test-env');

test('safe test DB guard accepts explicit local test, dev, and ci database names', () => {
  const safeUris = [
    'mongodb://localhost:27017/ara_financial_test',
    'mongodb://127.0.0.1:27017/ara_financial_dev',
    'mongodb://mongo:27017/ara-financial-ci',
    'mongodb://mongo-ci:27017/ara_financial_test',
  ];

  for (const uri of safeUris) {
    assert.doesNotThrow(() => assertSafeMongoTestUri(uri), uri);
    assert.deepEqual(getSafeMongoUriErrors(uri), []);
  }
});

test('safe test DB guard rejects production-like or remote Atlas MongoDB URIs', () => {
  const unsafeUris = [
    {
      uri: 'mongodb+srv://cluster.mongodb.net/ara_financial_test',
      message: /must not use mongodb\+srv/,
    },
    {
      uri: 'mongodb://cluster.mongodb.net/ara_financial_test',
      message: /must not point tests at an Atlas host/,
    },
    {
      uri: 'mongodb://prod-db.local:27017/ara_financial_test',
      message: /host looks production-like/,
    },
    {
      uri: 'mongodb://db01.internal:27017/ara_financial_test',
      message: /host must be local or clearly test\/dev\/ci/,
    },
    {
      uri: 'mongodb://localhost:27017/ara_financial',
      message: /must clearly contain test, dev, or ci/,
    },
    {
      uri: 'mongodb://localhost:27017/ara_financial_prod',
      message: /database name looks production-like/,
    },
    {
      uri: 'mongodb://localhost:27017',
      message: /explicit test database name/,
    },
  ];

  for (const { uri, message } of unsafeUris) {
    assert.match(getSafeMongoUriErrors(uri).join('\n'), message, uri);
    assert.throws(() => assertSafeMongoTestUri(uri), message, uri);
  }
});

test('safe test environment guard requires NODE_ENV=test', () => {
  const errors = getSafeTestEnvironmentErrors({
    NODE_ENV: 'development',
    MONGODB_URI: 'mongodb://localhost:27017/ara_financial_test',
  });

  assert.match(errors.join('\n'), /NODE_ENV must be "test"/);
});
