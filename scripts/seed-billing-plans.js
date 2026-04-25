'use strict';

/**
 * Safely seeds SaaS billing plans.
 *
 * The seed is idempotent and uses $setOnInsert by plan code, so existing
 * custom names, limits, or pricing are not overwritten.
 */

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { disconnectRedis } = require('../src/config/redis');
const billingService = require('../src/modules/billing/billing.service');

async function main() {
  await connectDatabase();

  try {
    const result = await billingService.seedDefaultPlans();

    console.log('Billing plans seed completed.');
    console.log(`Inserted: ${result.inserted}`);
    console.log(`Existing matched: ${result.matched}`);
    console.log(`Modified: ${result.modified}`);
    console.log(`Default plan codes present: ${result.planCodes.join(', ')}`);
    console.log('Existing plans are left unchanged; placeholder prices are only inserted when missing.');
  } finally {
    await disconnectDatabase();
    await disconnectRedis();
  }
}

main().catch((error) => {
  console.error('Billing plan seed failed.');
  console.error(error.message);
  process.exitCode = 1;
});
