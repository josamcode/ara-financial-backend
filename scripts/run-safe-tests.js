'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  configureSafeTestEnvironment,
  printSafeTestEnvironmentError,
} = require('./safe-test-env');

const backendRoot = path.resolve(__dirname, '..');

try {
  configureSafeTestEnvironment({ backendRoot });
} catch (error) {
  printSafeTestEnvironmentError(error);
  process.exit(1);
}

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
