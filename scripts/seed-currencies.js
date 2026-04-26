'use strict';

/**
 * Idempotently seeds supported currencies.
 *
 * Existing currency names, symbols, decimal settings, and sort order are left
 * unchanged unless the field is missing. SAR is enforced as the default.
 */

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { disconnectRedis } = require('../src/config/redis');
const currencyService = require('../src/modules/currency/currency.service');

async function main() {
  await connectDatabase();

  try {
    const result = await currencyService.seedDefaultCurrencies();

    console.log('Currency seed completed.');
    console.log(`Inserted: ${result.inserted}`);
    console.log(`Existing matched: ${result.matched}`);
    console.log(`Modified: ${result.modified}`);
    console.log(`Default currency codes present: ${result.currencyCodes.join(', ')}`);
    console.log('Existing custom values are left unchanged unless missing.');
  } finally {
    await disconnectDatabase();
    await disconnectRedis();
  }
}

main().catch((error) => {
  console.error('Currency seed failed.');
  console.error(error.message);
  process.exitCode = 1;
});
