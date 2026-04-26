'use strict';

/**
 * ARA Financial - MVP Verification Script
 *
 * This script validates critical accounting and security invariants:
 * 1. Auth and tenant setup
 * 2. Role hierarchy enforcement
 * 3. Fiscal period enforcement on journal operations
 * 4. Double-entry and reversal integrity
 * 5. Tenant isolation
 * 6. Report correctness
 * 7. Decimal-safe ledger and dashboard views
 *
 * Prerequisites: MongoDB and Redis running locally.
 * Defaults to mongodb://localhost:27017/ara_financial_test unless .env.test
 * or the shell provides another safe test/dev/ci database URI.
 *
 * Usage: npm run verify
 */

const {
  configureSafeTestEnvironment,
  printSafeTestEnvironmentError,
} = require('./safe-test-env');

try {
  configureSafeTestEnvironment();
} catch (error) {
  printSafeTestEnvironmentError(error);
  process.exit(1);
}

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { disconnectRedis } = require('../src/config/redis');
const config = require('../src/config');

// Import services
const authService = require('../src/modules/auth/auth.service');
const accountService = require('../src/modules/account/account.service');
const userService = require('../src/modules/user/user.service');
const journalService = require('../src/modules/journal/journal.service');
const ledgerService = require('../src/modules/ledger/ledger.service');
const reportService = require('../src/modules/report/report.service');
const dashboardService = require('../src/modules/dashboard/dashboard.service');
const billingService = require('../src/modules/billing/billing.service');
const fiscalPeriodService = require('../src/modules/fiscal-period/fiscalPeriod.service');
const tenantService = require('../src/modules/tenant/tenant.service');
const {
  toScaledInteger,
  formatScaledInteger,
} = require('../src/common/utils/money');

// Import models directly for cleanup
const User = require('../src/modules/user/user.model');
const Tenant = require('../src/modules/tenant/tenant.model');
const { Role } = require('../src/modules/auth/role.model');
const { Account } = require('../src/modules/account/account.model');
const { Plan } = require('../src/modules/billing/plan.model');
const { TenantSubscription } = require('../src/modules/billing/tenant-subscription.model');
const { JournalEntry } = require('../src/modules/journal/journal.model');
const JournalCounter = require('../src/modules/journal/journalCounter.model');
const { FiscalPeriod } = require('../src/modules/fiscal-period/fiscalPeriod.model');
const AuditLog = require('../src/modules/audit/audit.model');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  PASS: ${testName}`);
    passed++;
  } else {
    console.log(`  FAIL: ${testName}`);
    failed++;
  }
}

function toIsoDate(year, month, day = 15) {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).toISOString();
}

async function cleanup(tenantIds) {
  for (const tenantId of tenantIds) {
    await JournalEntry.deleteMany({ tenantId });
    await Account.deleteMany({ tenantId });
    await FiscalPeriod.deleteMany({ tenantId });
    await JournalCounter.deleteMany({ tenantId });
    await TenantSubscription.deleteMany({ tenantId });
    await AuditLog.collection.deleteMany({ tenantId });
    await User.deleteMany({ tenantId });
    await Role.deleteMany({ tenantId });
    await Tenant.findByIdAndDelete(tenantId);
  }
}

async function ensureVerificationSubscription(tenantId) {
  await billingService.ensureDefaultPlans();

  const plan = await Plan.findOne({
    code: 'enterprise',
    isActive: true,
  });
  if (!plan) {
    throw new Error('Enterprise billing plan fixture not found');
  }

  const now = new Date();
  const currentPeriodEnd = new Date(now);
  currentPeriodEnd.setUTCMonth(currentPeriodEnd.getUTCMonth() + 1);

  return TenantSubscription.findOneAndUpdate(
    { tenantId },
    {
      $set: {
        planId: plan._id,
        status: 'trialing',
        currentPeriodStart: now,
        currentPeriodEnd,
        cancelAtPeriodEnd: false,
      },
      $setOnInsert: {
        tenantId,
      },
    },
    {
      upsert: true,
      returnDocument: 'after',
    }
  );
}

async function run() {
  console.log('\nARA Financial - MVP Verification\n');
  console.log('='.repeat(50));

  await connectDatabase();

  const tenantIds = [];

  try {
    const unique = Date.now();
    const auditContextA = {
      ip: '10.20.30.40',
      userAgent: 'verify-suite/1.0 tenant-a',
    };
    const auditContextB = {
      ip: '10.20.30.41',
      userAgent: 'verify-suite/1.0 tenant-b',
    };

    console.log('\nTest Group 1: Authentication and Tenant Setup\n');

    const tenantA = await authService.register({
      email: `verify_a_${unique}@test.com`,
      password: 'TestPass1',
      name: 'Test User A',
      companyName: 'Tenant A Corp',
    }, { auditContext: auditContextA });
    tenantIds.push(tenantA.tenant._id);
    await ensureVerificationSubscription(tenantA.tenant._id);

    assert(
      tenantA.user && tenantA.tenant && tenantA.accessToken,
      'Register creates user, tenant, and tokens'
    );
    assert(
      tenantA.user.tenantId.toString() === tenantA.tenant._id.toString(),
      'User belongs to created tenant'
    );

    const tenantB = await authService.register({
      email: `verify_b_${unique}@test.com`,
      password: 'TestPass1',
      name: 'Test User B',
      companyName: 'Tenant B Corp',
    }, { auditContext: auditContextB });
    tenantIds.push(tenantB.tenant._id);
    await ensureVerificationSubscription(tenantB.tenant._id);

    assert(
      tenantA.tenant._id.toString() !== tenantB.tenant._id.toString(),
      'Two tenants have different IDs'
    );

    const rollbackEmail = `verify_register_rollback_${unique}@test.com`;
    const rollbackCompanyName = `Tenant Rollback ${unique}`;
    const originalUserSave = User.prototype.save;
    let registerFailureInjected = false;
    let rollbackTenantId = null;

    User.prototype.save = async function (...args) {
      if (this.isNew && this.email === rollbackEmail) {
        registerFailureInjected = true;
        rollbackTenantId = this.tenantId;
        throw new Error('Injected registration failure');
      }

      return originalUserSave.apply(this, args);
    };

    let registrationRollbackObserved = false;
    try {
      await authService.register({
        email: rollbackEmail,
        password: 'TestPass1',
        name: 'Rollback User',
        companyName: rollbackCompanyName,
      }, { auditContext: auditContextA });
    } catch (err) {
      registrationRollbackObserved = err.message.includes('Injected registration failure');
    } finally {
      User.prototype.save = originalUserSave;
    }

    const rolledBackTenant = await Tenant.findOne({ name: rollbackCompanyName });
    const rolledBackUser = await User.findOne({ email: rollbackEmail }).setOptions({
      __skipTenantFilter: true,
    });
    const rolledBackRoleCount = rollbackTenantId
      ? await Role.countDocuments({ tenantId: rollbackTenantId })
      : 0;

    assert(
      registerFailureInjected && registrationRollbackObserved,
      'Registration flow surfaces mid-flow persistence failures'
    );
    assert(
      !rolledBackTenant && !rolledBackUser && rolledBackRoleCount === 0,
      'Registration flow rolls back tenant, role, and user state on failure'
    );

    const loginResult = await authService.login(
      { email: `verify_a_${unique}@test.com`, password: 'TestPass1' },
      auditContextA.ip,
      { auditContext: auditContextA }
    );
    assert(
      loginResult.accessToken && loginResult.refreshToken,
      'Login returns access and refresh tokens'
    );

    const refreshResult = await authService.refresh(loginResult.refreshToken, {
      auditContext: auditContextA,
    });
    assert(
      refreshResult.accessToken && refreshResult.refreshToken,
      'Token refresh works'
    );

    console.log('\nTest Group 2: Chart of Accounts\n');

    const templateCountA = await accountService.applyTemplate(
      tenantA.tenant._id,
      'egyptian',
      { userId: tenantA.user._id, auditContext: auditContextA }
    );
    const templateCountB = await accountService.applyTemplate(
      tenantB.tenant._id,
      'egyptian',
      { userId: tenantB.user._id, auditContext: auditContextB }
    );

    const templateRollbackTenant = await authService.register({
      email: `verify_template_rollback_${unique}@test.com`,
      password: 'TestPass1',
      name: 'Template Rollback User',
      companyName: `Template Rollback Tenant ${unique}`,
    }, { auditContext: auditContextA });
    tenantIds.push(templateRollbackTenant.tenant._id);
    await ensureVerificationSubscription(templateRollbackTenant.tenant._id);

    const originalBulkWrite = Account.bulkWrite.bind(Account);
    let templateFailureInjected = false;

    Account.bulkWrite = async function (...args) {
      templateFailureInjected = true;
      throw new Error('Injected template failure');
    };

    let templateRollbackObserved = false;
    try {
      await accountService.applyTemplate(
        templateRollbackTenant.tenant._id,
        'egyptian',
        { userId: templateRollbackTenant.user._id, auditContext: auditContextA }
      );
    } catch (err) {
      templateRollbackObserved = err.message.includes('Injected template failure');
    } finally {
      Account.bulkWrite = originalBulkWrite;
    }

    const rolledBackAccountCount = await Account.countDocuments({
      tenantId: templateRollbackTenant.tenant._id,
    });

    assert(
      templateFailureInjected && templateRollbackObserved,
      'Template seeding flow surfaces parent-linking failures'
    );
    assert(
      rolledBackAccountCount === 0,
      'Template seeding flow rolls back inserted accounts on failure'
    );

    assert(templateCountA > 30, `Tenant A template creates ${templateCountA} accounts`);
    assert(templateCountB > 30, `Tenant B template creates ${templateCountB} accounts`);

    const accountsA = await Account.find({ tenantId: tenantA.tenant._id });
    const accountsB = await Account.find({ tenantId: tenantB.tenant._id });

    assert(accountsA.length > 0 && accountsB.length > 0, 'Both tenants have accounts');
    assert(
      accountsA.every((account) => account.tenantId.toString() === tenantA.tenant._id.toString()),
      'Tenant A accounts all belong to Tenant A'
    );

    const hierarchyParent = await accountService.createAccount(
      tenantA.tenant._id,
      {
        code: `97${String(unique).slice(-4)}`,
        nameAr: 'حساب أصل',
        nameEn: 'Hierarchy Parent',
        type: 'expense',
      },
      {
        userId: tenantA.user._id,
        auditContext: auditContextA,
      }
    );
    const hierarchyChild = await accountService.createAccount(
      tenantA.tenant._id,
      {
        code: `96${String(unique).slice(-4)}`,
        nameAr: 'حساب فرعي',
        nameEn: 'Hierarchy Child',
        type: 'expense',
        parentId: hierarchyParent._id.toString(),
      },
      {
        userId: tenantA.user._id,
        auditContext: auditContextA,
      }
    );
    const hierarchyGrandchild = await accountService.createAccount(
      tenantA.tenant._id,
      {
        code: `95${String(unique).slice(-4)}`,
        nameAr: 'حساب حفيد',
        nameEn: 'Hierarchy Grandchild',
        type: 'expense',
        parentId: hierarchyChild._id.toString(),
      },
      {
        userId: tenantA.user._id,
        auditContext: auditContextA,
      }
    );

    let selfParentRejected = false;
    try {
      await accountService.updateAccount(
        hierarchyParent._id,
        tenantA.tenant._id,
        { parentId: hierarchyParent._id.toString() },
        {
          userId: tenantA.user._id,
          auditContext: auditContextA,
        }
      );
    } catch (err) {
      selfParentRejected = err.message.includes('own parent');
    }
    assert(selfParentRejected, 'Accounts cannot be re-parented to themselves');

    let descendantParentRejected = false;
    try {
      await accountService.updateAccount(
        hierarchyParent._id,
        tenantA.tenant._id,
        { parentId: hierarchyGrandchild._id.toString() },
        {
          userId: tenantA.user._id,
          auditContext: auditContextA,
        }
      );
    } catch (err) {
      descendantParentRejected = err.message.includes('descendant');
    }
    assert(
      descendantParentRejected,
      'Accounts cannot be re-parented under one of their descendants'
    );

    console.log('\nTest Group 3: Invitation, Recovery, and Role Hierarchy\n');

    const invitedAdmin = await userService.inviteUser(
      tenantA.tenant._id,
      tenantA.user._id,
      {
        email: `verify_admin_${unique}@test.com`,
        name: 'Tenant A Admin',
        roleName: 'admin',
      },
      { auditContext: auditContextA }
    );

    const pendingAdminInvite = await User.findOne({
      _id: invitedAdmin.user._id,
      tenantId: tenantA.tenant._id,
    })
      .select('+invitationToken')
      .setOptions({ __skipTenantFilter: true });

    assert(
      invitedAdmin.user && invitedAdmin.invitation && invitedAdmin.invitation.token,
      'Inviting a user returns a one-time invitation token'
    );
    assert(
      pendingAdminInvite &&
      pendingAdminInvite.isActive === false &&
      pendingAdminInvite.invitationToken !== invitedAdmin.invitation.token,
      'Invitation tokens are stored hashed and invited users stay inactive'
    );

    const acceptedAdmin = await authService.acceptInvite(
      {
        token: invitedAdmin.invitation.token,
        password: 'AdminPass1',
        language: 'en',
      },
      { auditContext: auditContextA }
    );

    assert(
      acceptedAdmin.user.isActive &&
      acceptedAdmin.user.emailVerified === true &&
      acceptedAdmin.accessToken &&
      acceptedAdmin.refreshToken,
      'Accepting an invitation activates the account and issues tokens'
    );

    const adminUser = await User.findOne({
      _id: invitedAdmin.user._id,
      tenantId: tenantA.tenant._id,
    })
      .select('+invitationToken')
      .setOptions({ __skipTenantFilter: true });

    assert(
      adminUser && adminUser.invitationToken === null,
      'Accepting an invitation clears the stored invite secret'
    );

    const adminLogin = await authService.login(
      { email: invitedAdmin.user.email, password: 'AdminPass1' },
      auditContextA.ip,
      { auditContext: auditContextA }
    );

    assert(
      adminLogin.accessToken && adminLogin.refreshToken,
      'Accepted invite users can log in with their chosen password'
    );

    const passwordResetRequest = await authService.requestPasswordReset(
      { email: invitedAdmin.user.email },
      { auditContext: auditContextA }
    );

    assert(
      passwordResetRequest.passwordReset && passwordResetRequest.passwordReset.token,
      'Password reset requests issue a one-time reset token'
    );

    await authService.resetPassword(
      {
        token: passwordResetRequest.passwordReset.token,
        password: 'AdminReset1',
      },
      { auditContext: auditContextA }
    );

    let staleRefreshRejected = false;
    try {
      await authService.refresh(adminLogin.refreshToken, {
        auditContext: auditContextA,
      });
    } catch (err) {
      staleRefreshRejected = err.message.includes('revoked');
    }
    assert(staleRefreshRejected, 'Password reset revokes previously issued refresh tokens');

    const resetLoginContext = {
      ip: '10.20.30.42',
      userAgent: 'verify-suite/1.0 admin-reset-login',
    };
    const resetLogin = await authService.login(
      { email: invitedAdmin.user.email, password: 'AdminReset1' },
      resetLoginContext.ip,
      { auditContext: resetLoginContext }
    );

    assert(
      resetLogin.accessToken && resetLogin.refreshToken,
      'Password reset updates credentials end to end'
    );

    const lockoutContext = {
      ip: '10.20.30.50',
      userAgent: 'verify-suite/1.0 admin-lockout',
    };
    let accountLocked = false;
    for (let attempt = 0; attempt < config.auth.accountLockoutAttempts; attempt++) {
      try {
        await authService.login(
          { email: invitedAdmin.user.email, password: 'WrongPass1' },
          lockoutContext.ip,
          { auditContext: lockoutContext }
        );
      } catch (err) {
        if (attempt === config.auth.accountLockoutAttempts - 1) {
          accountLocked = err.statusCode === 429;
        }
      }
    }
    assert(accountLocked, 'Repeated invalid logins lock the account');

    const lockedAccountContext = {
      ip: '10.20.30.51',
      userAgent: 'verify-suite/1.0 locked-account-check',
    };
    let lockedCorrectPasswordRejected = false;
    try {
      await authService.login(
        { email: invitedAdmin.user.email, password: 'AdminReset1' },
        lockedAccountContext.ip,
        { auditContext: lockedAccountContext }
      );
    } catch (err) {
      lockedCorrectPasswordRejected = err.statusCode === 429;
    }
    assert(
      lockedCorrectPasswordRejected,
      'Locked accounts reject login even when the password is correct'
    );

    const unlockResetRequest = await authService.requestPasswordReset(
      { email: invitedAdmin.user.email },
      { auditContext: auditContextA }
    );
    await authService.resetPassword(
      {
        token: unlockResetRequest.passwordReset.token,
        password: 'AdminUnlocked1',
      },
      { auditContext: auditContextA }
    );

    const unlockedLoginContext = {
      ip: '10.20.30.52',
      userAgent: 'verify-suite/1.0 admin-unlocked-login',
    };
    const unlockedLogin = await authService.login(
      { email: invitedAdmin.user.email, password: 'AdminUnlocked1' },
      unlockedLoginContext.ip,
      { auditContext: unlockedLoginContext }
    );

    assert(
      unlockedLogin.accessToken && unlockedLogin.refreshToken,
      'Password reset clears account lockout and restores access'
    );

    let ownerPromotionRejected = false;
    try {
      await userService.changeUserRole(
        tenantA.user._id.toString(),
        tenantA.tenant._id.toString(),
        adminUser._id.toString(),
        { roleName: 'owner' }
      );
    } catch (err) {
      ownerPromotionRejected = err.message.includes('same or higher role');
    }
    assert(ownerPromotionRejected, 'Admin cannot promote another user to owner');

    let ownerDeactivationRejected = false;
    try {
      await userService.deactivateUser(
        tenantA.user._id.toString(),
        tenantA.tenant._id.toString(),
        adminUser._id.toString()
      );
    } catch (err) {
      ownerDeactivationRejected = err.message.includes('same or higher role');
    }
    assert(ownerDeactivationRejected, 'Admin cannot deactivate an owner');

    console.log('\nTest Group 4: Fiscal Periods\n');

    const cashAccount = accountsA.find((account) => account.code === '1111');
    const bankAccount = accountsA.find((account) => account.code === '1112');
    const revenueAccount = accountsA.find((account) => account.code === '4100');
    const expenseAccount = accountsA.find((account) => account.code === '5200');

    assert(
      cashAccount && bankAccount && revenueAccount && expenseAccount,
      'Found core accounts for verification'
    );

    let missingPeriodRejected = false;
    try {
      await journalService.createEntry(
        tenantA.tenant._id,
        tenantA.user._id,
        {
          date: new Date().toISOString(),
          description: 'Verification: missing fiscal period',
          lines: [
            { accountId: cashAccount._id.toString(), debit: '100.00', credit: '0' },
            { accountId: revenueAccount._id.toString(), debit: '0', credit: '100.00' },
          ],
        }
      );
    } catch (err) {
      missingPeriodRejected = err.message.includes('No fiscal period found');
    }
    assert(missingPeriodRejected, 'Cannot create entries without an open fiscal period');

    const year = new Date().getFullYear();
    const periodsA = await fiscalPeriodService.createFiscalYear(
      tenantA.tenant._id,
      { year },
      { userId: tenantA.user._id, auditContext: auditContextA }
    );
    const periodsB = await fiscalPeriodService.createFiscalYear(
      tenantB.tenant._id,
      { year },
      { userId: tenantB.user._id, auditContext: auditContextB }
    );

    assert(
      periodsA.length === 12 && periodsB.length === 12,
      'Created 12 monthly periods for both tenants'
    );

    const periodsByMonthA = new Map(periodsA.map((period) => [period.month, period]));
    const currentMonth = new Date().getMonth() + 1;
    const currentPeriodA = periodsByMonthA.get(currentMonth);
    const nonCurrentMonths = Array.from({ length: 12 }, (_, index) => index + 1)
      .filter((month) => month !== currentMonth);
    const [lockTestMonth, reversalSourceMonth, updateFromMonth, updateToMonth] = nonCurrentMonths;

    console.log('\nTest Group 5: Double-Entry and Period Integrity\n');

    const balancedEntry = await journalService.createEntry(
      tenantA.tenant._id,
      tenantA.user._id,
      {
        date: new Date().toISOString(),
        description: 'Verification: balanced entry',
        reference: 'VER-001',
        lines: [
          { accountId: cashAccount._id.toString(), debit: '1000.00', credit: '0' },
          { accountId: revenueAccount._id.toString(), debit: '0', credit: '1000.00' },
        ],
      },
      { auditContext: auditContextA }
    );

    assert(
      balancedEntry && balancedEntry.entryNumber === 1,
      'Balanced entry created successfully'
    );
    assert(
      balancedEntry.fiscalPeriodId.toString() === currentPeriodA._id.toString(),
      'Balanced entry is linked to the matching fiscal period'
    );

    let unbalancedRejected = false;
    try {
      await journalService.createEntry(
        tenantA.tenant._id,
        tenantA.user._id,
        {
          date: new Date().toISOString(),
          description: 'Verification: unbalanced entry',
          lines: [
            { accountId: cashAccount._id.toString(), debit: '1000.00', credit: '0' },
            { accountId: revenueAccount._id.toString(), debit: '0', credit: '500.00' },
          ],
        }
      );
    } catch (err) {
      unbalancedRejected = err.message.includes('not balanced');
    }
    assert(unbalancedRejected, 'Unbalanced entry is rejected');

    let singleLineRejected = false;
    try {
      await journalService.createEntry(
        tenantA.tenant._id,
        tenantA.user._id,
        {
          date: new Date().toISOString(),
          description: 'Verification: single line',
          lines: [
            { accountId: cashAccount._id.toString(), debit: '500.00', credit: '0' },
          ],
        }
      );
    } catch (_err) {
      singleLineRejected = true;
    }
    assert(singleLineRejected, 'Single-line entry is rejected');

    let bothSidesRejected = false;
    try {
      await journalService.createEntry(
        tenantA.tenant._id,
        tenantA.user._id,
        {
          date: new Date().toISOString(),
          description: 'Verification: both sides on one line',
          lines: [
            { accountId: cashAccount._id.toString(), debit: '500.00', credit: '500.00' },
            { accountId: revenueAccount._id.toString(), debit: '500.00', credit: '0' },
          ],
        }
      );
    } catch (_err) {
      bothSidesRejected = true;
    }
    assert(bothSidesRejected, 'Line with both debit and credit is rejected');

    const dateShiftEntry = await journalService.createEntry(
      tenantA.tenant._id,
      tenantA.user._id,
      {
        date: toIsoDate(year, updateFromMonth, 10),
        description: 'Verification: date change updates period',
        lines: [
          { accountId: cashAccount._id.toString(), debit: '250.00', credit: '0' },
          { accountId: revenueAccount._id.toString(), debit: '0', credit: '250.00' },
        ],
      },
      { auditContext: auditContextA }
    );

    assert(
      dateShiftEntry.fiscalPeriodId.toString() === periodsByMonthA.get(updateFromMonth)._id.toString(),
      'Entry initially uses the fiscal period for its original date'
    );

    const shiftedEntry = await journalService.updateEntry(
      dateShiftEntry._id,
      tenantA.tenant._id,
      tenantA.user._id,
      { date: toIsoDate(year, updateToMonth, 10) },
      { auditContext: auditContextA }
    );

    assert(
      shiftedEntry.fiscalPeriodId.toString() === periodsByMonthA.get(updateToMonth)._id.toString(),
      'Changing an entry date recomputes its fiscal period'
    );

    const lockedDraftEntry = await journalService.createEntry(
      tenantA.tenant._id,
      tenantA.user._id,
      {
        date: toIsoDate(year, lockTestMonth, 12),
        description: 'Verification: locked period edit check',
        lines: [
          { accountId: cashAccount._id.toString(), debit: '150.00', credit: '0' },
          { accountId: revenueAccount._id.toString(), debit: '0', credit: '150.00' },
        ],
      },
      { auditContext: auditContextA }
    );

    await fiscalPeriodService.lockPeriod(
      periodsByMonthA.get(lockTestMonth)._id,
      tenantA.tenant._id,
      tenantA.user._id,
      { auditContext: auditContextA }
    );

    let lockedPeriodEditRejected = false;
    try {
      await journalService.updateEntry(
        lockedDraftEntry._id,
        tenantA.tenant._id,
        tenantA.user._id,
        { description: 'Trying to edit a locked-period draft' }
      );
    } catch (err) {
      lockedPeriodEditRejected = err.message.includes('locked');
    }
    assert(lockedPeriodEditRejected, 'Locked-period drafts cannot be edited');

    const postedEntry = await journalService.postEntry(
      balancedEntry._id,
      tenantA.tenant._id,
      tenantA.user._id,
      { auditContext: auditContextA }
    );

    assert(postedEntry.status === 'posted', 'Entry posted successfully');

    let editPostedRejected = false;
    try {
      await journalService.updateEntry(
        postedEntry._id,
        tenantA.tenant._id,
        tenantA.user._id,
        { description: 'Trying to modify posted entry' }
      );
    } catch (_err) {
      editPostedRejected = true;
    }
    assert(editPostedRejected, 'Posted entries remain immutable');

    const reversalSourceEntry = await journalService.createEntry(
      tenantA.tenant._id,
      tenantA.user._id,
      {
        date: toIsoDate(year, reversalSourceMonth, 20),
        description: 'Verification: reversal period linkage',
        reference: 'VER-REV-001',
        lines: [
          { accountId: cashAccount._id.toString(), debit: '500.00', credit: '0' },
          { accountId: revenueAccount._id.toString(), debit: '0', credit: '500.00' },
        ],
      },
      { auditContext: auditContextA }
    );

    await journalService.postEntry(
      reversalSourceEntry._id,
      tenantA.tenant._id,
      tenantA.user._id,
      { auditContext: auditContextA }
    );

    const reversedEntry = await journalService.reverseEntry(
      reversalSourceEntry._id,
      tenantA.tenant._id,
      tenantA.user._id,
      { auditContext: auditContextA }
    );

    assert(reversedEntry.isReversing === true, 'Reversal entry created');
    assert(reversedEntry.status === 'posted', 'Reversal entry is auto-posted');
    assert(
      reversedEntry.fiscalPeriodId.toString() === currentPeriodA._id.toString(),
      'Reversal entry uses the fiscal period for the reversal date'
    );
    assert(
      reversedEntry.fiscalPeriodId.toString() !== reversalSourceEntry.fiscalPeriodId.toString(),
      'Reversal entry does not reuse the original fiscal period'
    );

    let duplicateReversalRejected = false;
    try {
      await journalService.reverseEntry(
        reversalSourceEntry._id,
        tenantA.tenant._id,
        tenantA.user._id
      );
    } catch (err) {
      duplicateReversalRejected = err.message.includes('already been reversed');
    }
    assert(duplicateReversalRejected, 'An entry cannot be reversed twice');

    console.log('\nTest Group 6: Tenant Isolation\n');

    const cashAccountB = accountsB.find((account) => account.code === '1111');
    const revenueAccountB = accountsB.find((account) => account.code === '4100');

    await journalService.createEntry(
      tenantB.tenant._id,
      tenantB.user._id,
      {
        date: new Date().toISOString(),
        description: 'Tenant B entry',
        lines: [
          { accountId: cashAccountB._id.toString(), debit: '2000.00', credit: '0' },
          { accountId: revenueAccountB._id.toString(), debit: '0', credit: '2000.00' },
        ],
      }
    );

    const entriesA = await JournalEntry.find({ tenantId: tenantA.tenant._id });
    const entriesB = await JournalEntry.find({ tenantId: tenantB.tenant._id });

    assert(
      entriesA.every((entry) => entry.tenantId.toString() === tenantA.tenant._id.toString()),
      'Tenant A entries stay isolated'
    );
    assert(
      entriesB.every((entry) => entry.tenantId.toString() === tenantB.tenant._id.toString()),
      'Tenant B entries stay isolated'
    );

    let crossTenantFailed = false;
    try {
      await journalService.getEntryById(entriesB[0]._id, tenantA.tenant._id);
    } catch (err) {
      crossTenantFailed = err.message.includes('not found');
    }
    assert(crossTenantFailed, 'Cross-tenant entry access returns not found');

    console.log('\nTest Group 7: Trial Balance Correctness\n');

    const salaryEntry = await journalService.createEntry(
      tenantA.tenant._id,
      tenantA.user._id,
      {
        date: new Date().toISOString(),
        description: 'Pay salaries',
        lines: [
          { accountId: expenseAccount._id.toString(), debit: '3000.00', credit: '0' },
          { accountId: cashAccount._id.toString(), debit: '0', credit: '3000.00' },
        ],
      },
      { auditContext: auditContextA }
    );
    await journalService.postEntry(salaryEntry._id, tenantA.tenant._id, tenantA.user._id, {
      auditContext: auditContextA,
    });

    const trialBalance = await reportService.getTrialBalance(tenantA.tenant._id, {});
    assert(trialBalance.totals.isBalanced, 'Trial balance stays balanced');
    const trialBalanceDifference = toScaledInteger(trialBalance.totals.difference || '0');
    assert(
      trialBalanceDifference === 0n,
      `Trial balance difference is ${trialBalance.totals.difference}`
    );

    console.log('\nTest Group 8: Financial Reports\n');

    const today = new Date();
    const startOfYear = new Date(today.getFullYear(), 0, 1);

    const incomeStatement = await reportService.getIncomeStatement(
      tenantA.tenant._id,
      { startDate: startOfYear.toISOString(), endDate: today.toISOString() }
    );
    assert(incomeStatement.totals.totalRevenue !== undefined, 'Income statement generated');
    assert(incomeStatement.totals.netIncome !== undefined, 'Net income calculated');

    const balanceSheet = await reportService.getBalanceSheet(
      tenantA.tenant._id,
      { asOfDate: today.toISOString() }
    );
    assert(balanceSheet.totals.totalAssets !== undefined, 'Balance sheet generated');
    assert(balanceSheet.totals.isBalanced, 'Balance sheet remains balanced');

    console.log('\nTest Group 9: Decimal-Safe Financial Views\n');

    const summaryBefore = await dashboardService.getSummary(tenantA.tenant._id);
    const veryLargeAmount = '9007199254740993.12';

    const bigPrecisionEntry = await journalService.createEntry(
      tenantA.tenant._id,
      tenantA.user._id,
      {
        date: new Date().toISOString(),
        description: 'Verification: large decimal precision entry',
        lines: [
          { accountId: bankAccount._id.toString(), debit: veryLargeAmount, credit: '0' },
          { accountId: revenueAccount._id.toString(), debit: '0', credit: veryLargeAmount },
        ],
      },
      { auditContext: auditContextA }
    );
    await journalService.postEntry(
      bigPrecisionEntry._id,
      tenantA.tenant._id,
      tenantA.user._id,
      { auditContext: auditContextA }
    );

    const bankLedger = await ledgerService.getAccountLedger(
      tenantA.tenant._id,
      bankAccount._id,
      { page: 1, limit: 50, skip: 0 }
    );
    const summaryAfter = await dashboardService.getSummary(tenantA.tenant._id);

    const expectedRevenue = formatScaledInteger(
      toScaledInteger(summaryBefore.totalRevenue) + toScaledInteger(veryLargeAmount)
    );
    const expectedNetIncome = formatScaledInteger(
      toScaledInteger(summaryBefore.netIncome) + toScaledInteger(veryLargeAmount)
    );

    assert(
      bankLedger.movements.length === 1 &&
      bankLedger.movements[0].debit === veryLargeAmount &&
      bankLedger.movements[0].balance === veryLargeAmount,
      'Ledger preserves large Decimal128 balances exactly'
    );
    assert(
      summaryAfter.totalRevenue === expectedRevenue,
      'Dashboard revenue totals preserve large Decimal128 precision'
    );
    assert(
      summaryAfter.netIncome === expectedNetIncome,
      'Dashboard net income preserves large Decimal128 precision'
    );

    console.log('\nTest Group 10: Auditability and Immutability\n');

    await tenantService.updateSettings(
      tenantA.tenant._id,
      {
        name: 'Tenant A Corp Updated',
        settings: { language: 'en' },
      },
      {
        userId: tenantA.user._id,
        auditContext: auditContextA,
      }
    );

    const customAccount = await accountService.createAccount(
      tenantA.tenant._id,
      {
        code: `99${String(unique).slice(-4)}`,
        nameAr: 'حساب تدقيق',
        nameEn: 'Audit Verification Account',
        type: 'expense',
      },
      {
        userId: tenantA.user._id,
        auditContext: auditContextA,
      }
    );

    await accountService.updateAccount(
      customAccount._id,
      tenantA.tenant._id,
      { nameEn: 'Audit Verification Account Updated' },
      {
        userId: tenantA.user._id,
        auditContext: auditContextA,
      }
    );

    await accountService.deleteAccount(customAccount._id, tenantA.tenant._id, {
      userId: tenantA.user._id,
      auditContext: auditContextA,
    });

    const loginAudit = await AuditLog.findOne({
      tenantId: tenantA.tenant._id,
      action: 'auth.logged_in',
      resourceId: tenantA.user._id,
    });
    const inviteAudit = await AuditLog.findOne({
      tenantId: tenantA.tenant._id,
      action: 'user.invited',
      resourceId: invitedAdmin.user._id,
    });
    const inviteAcceptedAudit = await AuditLog.findOne({
      tenantId: tenantA.tenant._id,
      action: 'auth.invite_accepted',
      resourceId: invitedAdmin.user._id,
    });
    const passwordResetRequestedAudit = await AuditLog.findOne({
      tenantId: tenantA.tenant._id,
      action: 'auth.password_reset_requested',
      resourceId: invitedAdmin.user._id,
    });
    const passwordResetCompletedAudit = await AuditLog.findOne({
      tenantId: tenantA.tenant._id,
      action: 'auth.password_reset_completed',
      resourceId: invitedAdmin.user._id,
    });
    const loginLockedAudit = await AuditLog.findOne({
      tenantId: tenantA.tenant._id,
      action: 'auth.login_locked',
      resourceId: invitedAdmin.user._id,
    });
    const tenantAudit = await AuditLog.findOne({
      tenantId: tenantA.tenant._id,
      action: 'tenant.settings_updated',
      resourceId: tenantA.tenant._id,
    });
    const accountAudit = await AuditLog.findOne({
      tenantId: tenantA.tenant._id,
      action: 'account.created',
      resourceId: customAccount._id,
    });
    const fiscalAudit = await AuditLog.findOne({
      tenantId: tenantA.tenant._id,
      action: 'fiscal_period.locked',
      resourceId: periodsByMonthA.get(lockTestMonth)._id,
    });
    const journalCreateAudit = await AuditLog.findOne({
      tenantId: tenantA.tenant._id,
      action: 'journal_entry.created',
      resourceId: balancedEntry._id,
    });

    assert(
      loginAudit &&
      loginAudit.ip === auditContextA.ip &&
      loginAudit.userAgent === auditContextA.userAgent,
      'Auth audit logs store IP and user agent metadata'
    );
    assert(Boolean(inviteAudit), 'User invitation actions are audited');
    assert(Boolean(inviteAcceptedAudit), 'Invitation acceptance actions are audited');
    assert(Boolean(passwordResetRequestedAudit), 'Password reset requests are audited');
    assert(Boolean(passwordResetCompletedAudit), 'Password reset completion is audited');
    assert(Boolean(loginLockedAudit), 'Account lockouts are audited');
    assert(Boolean(tenantAudit), 'Tenant settings updates are audited');
    assert(Boolean(accountAudit), 'Account creation actions are audited');
    assert(Boolean(fiscalAudit), 'Fiscal period state changes are audited');
    assert(
      journalCreateAudit &&
      journalCreateAudit.ip === auditContextA.ip &&
      journalCreateAudit.userAgent === auditContextA.userAgent,
      'Journal audit logs now include request metadata'
    );

    let auditUpdateRejected = false;
    try {
      await AuditLog.updateOne(
        { _id: loginAudit._id },
        { $set: { action: 'tampered.action' } }
      );
    } catch (err) {
      auditUpdateRejected = err.message.includes('immutable');
    }
    assert(auditUpdateRejected, 'Audit logs reject query updates');

    let auditDeleteRejected = false;
    try {
      await AuditLog.deleteOne({ _id: loginAudit._id });
    } catch (err) {
      auditDeleteRejected = err.message.includes('immutable');
    }
    assert(auditDeleteRejected, 'Audit logs reject query deletes');

    let auditSaveRejected = false;
    try {
      loginAudit.action = 'tampered.save';
      await loginAudit.save();
    } catch (err) {
      auditSaveRejected = err.message.includes('immutable');
    }
    assert(auditSaveRejected, 'Audit logs reject document saves after creation');
  } catch (error) {
    console.error('\nUnexpected error during verification:', error.message);
    console.error(error.stack);
    failed++;
  } finally {
    console.log('\nCleaning up test data...');
    await cleanup(tenantIds);

    console.log('\n' + '='.repeat(50));
    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

    await disconnectDatabase();
    await disconnectRedis();
    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
