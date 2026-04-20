'use strict';

const config = require('./config');
const logger = require('./config/logger');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { disconnectRedis } = require('./config/redis');
const createApp = require('./app');

async function start() {
  try {
    // Connect to databases
    await connectDatabase();

    // Create and start Express app
    const app = createApp();

    const server = app.listen(config.port, () => {
      logger.info(
        { port: config.port, env: config.env },
        `ARA Financial API running on port ${config.port} [${config.env}]`
      );
    });

    // ── Graceful shutdown ───────────────────────────
    const shutdown = async (signal) => {
      logger.info(`${signal} received, shutting down gracefully...`);
      server.close(async () => {
        await disconnectDatabase();
        await disconnectRedis();
        logger.info('Server shut down successfully');
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Unhandled rejections
    process.on('unhandledRejection', (reason) => {
      logger.fatal({ err: reason }, 'Unhandled rejection');
      process.exit(1);
    });

    process.on('uncaughtException', (error) => {
      logger.fatal({ err: error }, 'Uncaught exception');
      process.exit(1);
    });
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

start();
