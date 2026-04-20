'use strict';

const Redis = require('ioredis');
const config = require('./index');
const logger = require('./logger');

let client = null;

function getRedisClient() {
  if (client) return client;

  client = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 5) {
        logger.error('Redis: max retries reached, giving up');
        return null;
      }
      return Math.min(times * 200, 2000);
    },
  });

  client.on('connect', () => {
    logger.info('Redis connected successfully');
  });

  client.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });

  return client;
}

async function disconnectRedis() {
  if (client) {
    await client.quit();
    client = null;
    logger.info('Redis disconnected gracefully');
  }
}

module.exports = { getRedisClient, disconnectRedis };
