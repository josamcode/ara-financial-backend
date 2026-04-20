# ARA Financial Postman Guide

## Overview

This folder contains a production-oriented Postman collection for the current `ara-financial-backend` implementation:

- `ara-financial-backend.postman_collection.json`
- `ara-financial-backend.postman_environment.json`

The collection was built from the live Express routes, controllers, middleware, validators, service logic, and tests in `src/` and `test/`.

## API Summary

Base path: `/api/v1`

Modules included:

- System
- Auth
- Tenant
- Accounts
- Fiscal Periods
- Journal Entries
- Ledger
- Reports
- Dashboard
- Users
- Audit Logs

The collection includes all currently implemented HTTP endpoints mounted in [src/app.js](/d:/work/ara%20financial/project_code/backend/src/app.js:1), including the unprotected health check and all protected module routes.

## Setup

1. Import `ara-financial-backend.postman_collection.json`.
2. Import `ara-financial-backend.postman_environment.json`.
3. Select the imported environment in Postman.
4. Set `baseUrl` to the running backend URL if it is not `http://localhost:5000`.
5. Start with `System -> Health Check`.

## Recommended Execution Order

The backend has a real setup dependency chain. For the smoothest manual QA flow, use this order:

1. `Auth -> Register Tenant Owner` or `Auth -> Login Owner`
2. `Auth -> Get Current User`
3. `Tenant -> Update Tenant Settings` (optional)
4. `Accounts -> Apply Egyptian Chart Of Accounts Template`
5. `Accounts -> List Accounts`
6. `Fiscal Periods -> Create Fiscal Year`
7. `Fiscal Periods -> List Fiscal Periods`
8. `Tenant -> Complete Tenant Setup` (optional, but realistic)
9. `Journal Entries -> Create Draft Entry`
10. `Journal Entries -> Post Draft Entry`
11. `Ledger` requests
12. `Reports` requests
13. `Dashboard -> Get Dashboard Summary`
14. `Users -> Invite User`
15. `Auth -> Accept Invite`
16. `Users` role/deactivation requests
17. `Audit Logs -> List Audit Logs`

## Environment Variables

Core variables:

- `baseUrl`: API base URL
- `accessToken`, `refreshToken`: active working token pair used by protected requests
- `tenantId`, `userId`: current authenticated tenant and user ids

Owner flow variables:

- `ownerEmail`, `ownerPassword`, `ownerName`, `companyName`, `language`
- `ownerAccessToken`, `ownerRefreshToken`

Invite flow variables:

- `inviteeEmail`, `inviteeName`, `inviteeRoleName`, `inviteePassword`
- `inviteToken`
- `inviteeAccessToken`, `inviteeRefreshToken`
- `targetUserId`

Accounting flow variables:

- `accountId`
- `cashAccountId`
- `revenueAccountId`
- `expenseAccountId`
- `fiscalYear`
- `fiscalStartMonth`
- `fiscalPeriodId`
- `journalId`
- `reversalJournalId`

Reporting variables:

- `reportStartDate`, `reportEndDate`
- `compareStartDate`, `compareEndDate`
- `balanceSheetAsOfDate`, `compareBalanceSheetAsOfDate`

Password reset testing:

- `resetToken`

## Auto-Stored Variables

The collection stores useful values automatically where the implementation makes them available:

- Register and Login store `accessToken`, `refreshToken`, `tenantId`, and `userId`
- Refresh updates the active token pair
- Invite stores `inviteToken` and `targetUserId`
- Accept Invite stores `inviteeAccessToken` and `inviteeRefreshToken`
- Create/List Accounts store `accountId`, and also try to capture seeded `1111`, `4100`, and `5200` account ids into `cashAccountId`, `revenueAccountId`, and `expenseAccountId`
- Create/List Fiscal Periods store `fiscalPeriodId`
- Create/List Journal Entries store `journalId`
- Reverse Posted Entry stores `reversalJournalId`
- Forgot Password stores `resetToken` only when the API exposes it

## Auth Notes

- Collection-level auth uses `Bearer {{accessToken}}`.
- Public auth routes override the collection auth with `noauth`.
- `POST /auth/refresh` revokes the previous refresh token and returns a new pair.
- `POST /auth/logout` requires a valid access token. The request body may omit `refreshToken`, but if you send it the backend revokes that refresh token.
- `POST /auth/forgot-password` is intentionally generic by default. The reset token only appears in the response when `EXPOSE_EMAIL_ACTION_TOKENS=true`.
- `POST /users/invite` always returns the one-time invitation token in the response because outbound email delivery is not implemented here.

## Important Behavioral Notes

- Register does **not** create the chart of accounts and does **not** create fiscal periods. Those steps must be done separately before journal, ledger, and report testing.
- Tenant settings routes do not use Zod validation. The service currently persists only these fields: `name`, `legalName`, `taxId`, `logoUrl`, `industry`, `fiscalYearStartMonth`, and `settings.dateFormat`, `settings.numberFormat`, `settings.language`.
- Report routes are strict. Unexpected query params return `422 VALIDATION_ERROR`.
- Some list routes are service-driven rather than schema-driven. The collection only includes params that the current implementation actually reads.
- Journal writes require:
  - an open fiscal period for the entry date
  - balanced debit/credit lines
  - active, non-parent-only accounts
- Posted journal entries are immutable. Use the reverse endpoint instead of update or delete.
- The account template can only be applied once while the tenant still has zero accounts.

## Permissions Overview

Default roles in the current codebase:

- `owner`: all permissions
- `admin`: all permissions used by current routes
- `accountant`: read/report/dashboard access plus journal create/update/post, but not account create/update/delete, tenant update, user invite/update/deactivate, or fiscal create/update/lock

## Known Constraints And Assumptions

- The collection documents only routes actually mounted by the app right now.
- Password reset is included because the endpoint exists, but end-to-end manual reset depends on `EXPOSE_EMAIL_ACTION_TOKENS=true` or another way to retrieve the token, since no outbound email service exists in this backend.
- Some routes without explicit param validation can return `400 INVALID_ID` from Mongoose casting instead of `422 VALIDATION_ERROR`.
- Export requests return files, not JSON bodies.
