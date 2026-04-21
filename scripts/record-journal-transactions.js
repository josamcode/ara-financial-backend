'use strict';

/**
 * Records a fixed set of journal transactions for a tenant.
 *
 * Easiest permanent change:
 * - Edit DEFAULTS.tenantId below.
 *
 * One-off overrides:
 * - npm run record:journal-transactions
 * - npm run record:journal-transactions -- --tenantId=<tenantId>
 * - npm run record:journal-transactions -- --tenantId=<tenantId> --date=2026-04-21
 * - $env:TENANT_ID="<tenantId>"; npm run record:journal-transactions
 */

const mongoose = require('mongoose');
const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { disconnectRedis } = require('../src/config/redis');
const Tenant = require('../src/modules/tenant/tenant.model');
const User = require('../src/modules/user/user.model');
const { Account } = require('../src/modules/account/account.model');
const { JournalEntry } = require('../src/modules/journal/journal.model');
const journalService = require('../src/modules/journal/journal.service');
const fiscalPeriodService = require('../src/modules/fiscal-period/fiscalPeriod.service');

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const DEFAULTS = Object.freeze({
  tenantId: '69e794ba14b6cd4e688bb8e8',
  journalDate: formatLocalDate(new Date()),
  referencePrefix: 'JNL-SETUP',
  postEntries: true,
  skipExisting: true,
});

const SCRIPT_AUDIT_CONTEXT = Object.freeze({
  ip: 'script://record-journal-transactions',
  userAgent: 'record-journal-transactions/1.0',
});

const TRANSACTIONS = Object.freeze([
  {
    number: 1,
    description: 'استثمار صاحب الشركة',
    lines: [
      { code: '1111', debit: '100000', credit: '0' },
      { code: '3100', debit: '0', credit: '100000' },
    ],
  },
  {
    number: 2,
    description: 'شراء معدات مكتبية نقدًا',
    lines: [
      { code: '1240', debit: '15000', credit: '0' },
      { code: '1111', debit: '0', credit: '15000' },
    ],
  },
  {
    number: 3,
    description: 'شراء مخزون من مورد على الحساب',
    lines: [
      { code: '1130', debit: '25000', credit: '0' },
      { code: '2110', debit: '0', credit: '25000' },
    ],
  },
  {
    number: 4,
    description: 'بيع منتجات نقدًا',
    lines: [
      { code: '1111', debit: '40000', credit: '0' },
      { code: '4100', debit: '0', credit: '40000' },
    ],
  },
  {
    number: 5,
    description: 'تكلفة البضاعة المباعة',
    lines: [
      { code: '5100', debit: '18000', credit: '0' },
      { code: '1130', debit: '0', credit: '18000' },
    ],
  },
  {
    number: 6,
    description: 'سداد جزء من حساب المورد',
    lines: [
      { code: '2110', debit: '10000', credit: '0' },
      { code: '1111', debit: '0', credit: '10000' },
    ],
  },
  {
    number: 7,
    description: 'دفع رواتب شهرية',
    lines: [
      { code: '5200', debit: '8000', credit: '0' },
      { code: '1111', debit: '0', credit: '8000' },
    ],
  },
  {
    number: 8,
    description: 'دفع إيجار الشهر',
    lines: [
      { code: '5300', debit: '5000', credit: '0' },
      { code: '1111', debit: '0', credit: '5000' },
    ],
  },
]);

function parseArgs(argv) {
  return argv.slice(2).reduce((accumulator, arg) => {
    if (!arg.startsWith('--')) {
      return accumulator;
    }

    const trimmed = arg.slice(2);
    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      accumulator[trimmed] = 'true';
      return accumulator;
    }

    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    accumulator[key] = value;
    return accumulator;
  }, {});
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;

  throw new Error(`Invalid boolean value "${value}"`);
}

function resolveOptions() {
  const cli = parseArgs(process.argv);
  const draftMode = parseBoolean(cli.draft, false);

  return {
    tenantId: cli.tenantId || process.env.TENANT_ID || DEFAULTS.tenantId,
    journalDate: cli.date || process.env.JOURNAL_DATE || DEFAULTS.journalDate,
    referencePrefix:
      cli.referencePrefix || process.env.JOURNAL_REFERENCE_PREFIX || DEFAULTS.referencePrefix,
    postEntries: draftMode
      ? false
      : parseBoolean(cli.postEntries || process.env.POST_JOURNAL_ENTRIES, DEFAULTS.postEntries),
    skipExisting: parseBoolean(
      cli.skipExisting || process.env.SKIP_EXISTING_JOURNALS,
      DEFAULTS.skipExisting
    ),
  };
}

function normalizeDateInput(value) {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid date "${value}". Use YYYY-MM-DD or a full ISO timestamp.`
    );
  }

  return parsed.toISOString();
}

function buildReference(referencePrefix, transactionNumber) {
  return `${referencePrefix}-${String(transactionNumber).padStart(3, '0')}`;
}

async function requireTenant(tenantId) {
  const tenant = await Tenant.findById(tenantId).select('name status');

  if (!tenant) {
    throw new Error(`Tenant ${tenantId} was not found.`);
  }

  if (tenant.status !== 'active') {
    throw new Error(`Tenant ${tenantId} is ${tenant.status} and cannot receive entries.`);
  }

  return tenant;
}

async function resolvePostingUser(tenantId) {
  const user = await User.findOne({ tenantId, isActive: true })
    .sort({ createdAt: 1 })
    .select('_id name email');

  if (!user) {
    throw new Error(`No active user was found for tenant ${tenantId}.`);
  }

  return user;
}

async function resolveAccountsByCode(tenantId) {
  const requiredCodes = [...new Set(
    TRANSACTIONS.flatMap((transaction) => transaction.lines.map((line) => line.code))
  )];

  const accounts = await Account.find({
    tenantId,
    code: { $in: requiredCodes },
  }).select('_id code nameAr nameEn isActive isParentOnly');

  const accountMap = new Map(accounts.map((account) => [account.code, account]));
  const missingCodes = requiredCodes.filter((code) => !accountMap.has(code));

  if (missingCodes.length > 0) {
    throw new Error(
      `Missing required accounts for tenant ${tenantId}: ${missingCodes.join(', ')}`
    );
  }

  const unusableAccounts = accounts.filter(
    (account) => !account.isActive || account.isParentOnly
  );

  if (unusableAccounts.length > 0) {
    throw new Error(
      `Some required accounts cannot receive journal lines: ${unusableAccounts
        .map((account) => `${account.code} (${account.nameEn})`)
        .join(', ')}`
    );
  }

  return accountMap;
}

async function requireOpenPeriod(tenantId, journalDate) {
  const period = await fiscalPeriodService.findPeriodForDate(tenantId, journalDate, {
    required: true,
  });

  if (period.status === 'locked') {
    throw new Error(`Fiscal period "${period.name}" is locked.`);
  }

  if (period.status === 'closed') {
    throw new Error(`Fiscal period "${period.name}" is closed.`);
  }

  return period;
}

function buildEntryPayload(transaction, accountMap, journalDateIso, referencePrefix) {
  return {
    date: journalDateIso,
    description: transaction.description,
    reference: buildReference(referencePrefix, transaction.number),
    lines: transaction.lines.map((line) => {
      const account = accountMap.get(line.code);

      return {
        accountId: account._id.toString(),
        debit: line.debit,
        credit: line.credit,
        description: `${transaction.description} - ${account.code}`,
      };
    }),
  };
}

async function recordTransaction({ tenantId, userId, journalDateIso, referencePrefix, postEntries }, accountMap, transaction) {
  const reference = buildReference(referencePrefix, transaction.number);
  const existingEntry = await JournalEntry.findOne({ tenantId, reference })
    .select('_id entryNumber status');

  if (existingEntry) {
    return {
      action: 'skipped',
      transactionNumber: transaction.number,
      description: transaction.description,
      reference,
      entryId: existingEntry._id.toString(),
      entryNumber: existingEntry.entryNumber,
      status: existingEntry.status,
    };
  }

  const createdEntry = await journalService.createEntry(
    tenantId,
    userId,
    buildEntryPayload(transaction, accountMap, journalDateIso, referencePrefix),
    { auditContext: SCRIPT_AUDIT_CONTEXT }
  );

  const finalEntry = postEntries
    ? await journalService.postEntry(createdEntry._id, tenantId, userId, {
      auditContext: SCRIPT_AUDIT_CONTEXT,
    })
    : createdEntry;

  return {
    action: 'created',
    transactionNumber: transaction.number,
    description: transaction.description,
    reference,
    entryId: finalEntry._id.toString(),
    entryNumber: finalEntry.entryNumber,
    status: finalEntry.status,
  };
}

async function main() {
  const options = resolveOptions();

  if (!mongoose.Types.ObjectId.isValid(options.tenantId)) {
    throw new Error(`Invalid tenantId "${options.tenantId}"`);
  }

  const journalDateIso = normalizeDateInput(options.journalDate);
  const journalDate = new Date(journalDateIso);

  await connectDatabase();

  try {
    const tenant = await requireTenant(options.tenantId);
    const user = await resolvePostingUser(options.tenantId);
    const period = await requireOpenPeriod(options.tenantId, journalDate);
    const accountMap = await resolveAccountsByCode(options.tenantId);

    console.log(`Tenant: ${tenant.name} (${options.tenantId})`);
    console.log(`Posting user: ${user.name} <${user.email}>`);
    console.log(`Journal date: ${journalDateIso}`);
    console.log(`Fiscal period: ${period.name} (${period.status})`);
    console.log(`Mode: ${options.postEntries ? 'create + post' : 'create draft only'}`);
    console.log(`Skip existing references: ${options.skipExisting ? 'yes' : 'no'}`);
    console.log('');

    const results = [];

    for (const transaction of TRANSACTIONS) {
      if (!options.skipExisting) {
        const existingEntry = await JournalEntry.findOne({
          tenantId: options.tenantId,
          reference: buildReference(options.referencePrefix, transaction.number),
        }).select('_id entryNumber status');

        if (existingEntry) {
          throw new Error(
            `Reference ${buildReference(options.referencePrefix, transaction.number)} already exists ` +
            `as entry #${existingEntry.entryNumber}. Re-run with a different referencePrefix or enable skipExisting.`
          );
        }
      }

      const result = await recordTransaction(
        {
          tenantId: options.tenantId,
          userId: user._id,
          journalDateIso,
          referencePrefix: options.referencePrefix,
          postEntries: options.postEntries,
        },
        accountMap,
        transaction
      );

      results.push(result);

      if (result.action === 'skipped') {
        console.log(
          `Skipped T${result.transactionNumber}: ${result.description} ` +
          `(${result.reference}, entry #${result.entryNumber}, ${result.status})`
        );
      } else {
        console.log(
          `Recorded T${result.transactionNumber}: ${result.description} ` +
          `(${result.reference}, entry #${result.entryNumber}, ${result.status})`
        );
      }
    }

    const createdCount = results.filter((result) => result.action === 'created').length;
    const skippedCount = results.filter((result) => result.action === 'skipped').length;

    console.log('');
    console.log(
      `Completed. Created ${createdCount} entr${createdCount === 1 ? 'y' : 'ies'} ` +
      `and skipped ${skippedCount}.`
    );
  } finally {
    await disconnectDatabase();
    await disconnectRedis();
  }
}

main().catch((error) => {
  console.error('');
  console.error('Failed to record journal transactions.');
  console.error(error.message);
  process.exitCode = 1;
});


// Use it like this:

// npm run record:journal-transactions
// npm run record:journal-transactions -- --tenantId=69e794ba14b6cd4e688bb8e8
// npm run record:journal-transactions -- --tenantId=<newTenantId> --date=2026-04-21
// npm run record:journal-transactions -- --draft