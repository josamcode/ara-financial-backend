'use strict';

const mongoose = require('mongoose');
const config = require('./index');
const logger = require('./logger');

async function connectDatabase() {
  try {
    await mongoose.connect(config.db.uri);
    logger.info('MongoDB connected successfully');
  } catch (error) {
    logger.fatal({ err: error }, 'MongoDB connection failed');
    process.exit(1);
  }

  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'MongoDB connection error');
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });
}

async function disconnectDatabase() {
  await mongoose.disconnect();
  logger.info('MongoDB disconnected gracefully');
}

module.exports = { connectDatabase, disconnectDatabase };
