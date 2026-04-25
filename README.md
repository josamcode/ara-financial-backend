# ARA Financial - MVP Backend

Multi-tenant cloud accounting SaaS backend for the MENA region.

## Stack

- **Runtime**: Node.js + Express 5
- **Database**: MongoDB (Mongoose 9)
- **Redis usage**: refresh-token state, login throttling, and short-lived report caching
- **Auth**: JWT (access + refresh) + bcrypt
- **Validation**: Zod
- **Logging**: Pino (structured JSON)
- **Security middleware**: Helmet, environment-aware CORS, and Redis-backed login throttling

## Quick Start

```bash
# Prerequisites: Node.js 20+, MongoDB, Redis

# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
cp .env.test.example .env.test
# Edit .env with your MongoDB/Redis URLs and JWT secret
# Edit .env.test only with a local/CI test MongoDB URI

# 3. Start development server
npm run dev

# 4. Run safe tests
npm test

# 5. Run the broader verification script
npm run verify

# 6. Seed and smoke-check SaaS billing support
npm run billing:seed
npm run billing:smoke
```

## Environment Variables

| Variable             | Required | Default                  | Description                  |
| -------------------- | -------- | ------------------------ | ---------------------------- |
| `MONGODB_URI`        | Yes      | -                        | MongoDB connection string    |
| `JWT_SECRET`         | Yes      | -                        | JWT signing secret           |
| `REDIS_URL`          | No       | `redis://localhost:6379` | Redis connection URL         |
| `PORT`               | No       | `5000`                   | Server port                  |
| `NODE_ENV`           | No       | `development`            | Environment                  |
| `JWT_ACCESS_EXPIRY`  | No       | `15m`                    | Access token lifetime        |
| `JWT_REFRESH_EXPIRY` | No       | `7d`                     | Refresh token lifetime       |
| `BCRYPT_ROUNDS`      | No       | `12`                     | Password hashing cost factor |
| `LOG_LEVEL`          | No       | `debug`                  | Pino log level               |

Tests must use `.env.test` or CI-provided environment variables. The test runner refuses to run unless `NODE_ENV=test` and `MONGODB_URI` points to a database name containing `test` or `ci`. Atlas/`mongodb+srv` URIs are rejected for tests.

## Scripts

| Script           | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `npm run dev`    | Start with nodemon (auto-restart)                    |
| `npm start`      | Production start                                     |
| `npm test`       | Run the automated test suite through the safety guard |
| `npm run test:safe` | Run the automated test suite through the safety guard |
| `npm run verify` | Run the supplementary end-to-end verification script |
| `npm run billing:seed` | Safely upsert default SaaS billing plans by code |
| `npm run billing:smoke` | Run the billing smoke check without calling MyFatoorah by default |

## SaaS Billing Support

Default SaaS plans can be safely inserted with:

```bash
npm run billing:seed
```

The seed uses plan `code` upserts and only inserts missing defaults. Existing plan pricing or custom metadata is not overwritten.

Run the backend billing smoke check with:

```bash
npm run billing:smoke
```

The smoke check refuses production-like MongoDB URIs and does not call MyFatoorah by default. Real checkout requires `MYFATOORAH_TOKEN`, `MYFATOORAH_BASE_URL`, and `MYFATOORAH_CALLBACK_BASE_URL`; set `BILLING_SMOKE_ENABLE_PAYMENT=true` only when intentionally testing the provider.

## Project Structure

```text
src/
|-- app.js                          # Express app factory
|-- server.js                       # Bootstrap + graceful shutdown
|-- config/                         # Configuration, DB, Redis, logger
|-- common/
|   |-- errors/                     # Custom error classes
|   |-- middleware/                 # Auth, validation, error handler, logging
|   |-- plugins/                    # Mongoose plugins (tenant, soft delete)
|   `-- utils/                      # Response helpers and export utilities
|-- modules/
|   |-- auth/                       # Register, login, refresh, invite acceptance, password reset, RBAC
|   |-- user/                       # User management (profile, invite, roles, deactivate)
|   |-- tenant/                     # Tenant settings
|   |-- account/                    # Chart of accounts (hierarchical tree)
|   |-- fiscal-period/              # Fiscal year and period management
|   |-- journal/                    # Journal entries (double-entry engine)
|   |-- ledger/                     # General ledger (derived views)
|   |-- report/                     # Financial reports and exports
|   |-- dashboard/                  # Dashboard summary
|   |-- customer/                   # Customer master data and statements
|   |-- supplier/                   # Supplier master data and statements
|   |-- invoice/                    # AR invoices and payment recording
|   |-- bill/                       # AP bills and payment recording
|   `-- audit/                      # Audit log storage and querying
|-- seeds/                          # Egyptian CoA template
|-- test/                           # Automated tests
`-- scripts/                        # Verification scripts
```

## Key Architectural Notes

1. **Modular monolith**: domain-organized modules with clear boundaries.
2. **Shared database + tenant plugin**: automatic `tenantId` filtering on tenant-scoped queries.
3. **Embedded journal lines**: balanced-entry validation and single-document journal persistence keep entry creation cohesive.
4. **Financial arithmetic**: fixed-point `BigInt` helpers are used for validations and derived balances, while persisted money values use MongoDB `Decimal128`.
5. **Multi-document integrity**: selected multi-document flows use MongoDB transactions where supported, with compensating cleanup for standalone environments.
6. **Redis-backed operational state**: Redis is used for login throttling, refresh-token revocation/state, and short-lived report caching.
7. **Audit logs**: audit records are append-only at the application/model layer and indexed for common tenant/resource queries.

## Current MVP Coverage

- Auth with registration, login, refresh, invite acceptance, password reset, and account lockout
- Multi-tenancy with shared DB tenant scoping
- Chart of accounts CRUD and Egyptian template seeding
- Journal entries with post and reverse flows
- General ledger views and CSV export
- Trial balance, income statement, balance sheet, and cash-flow reporting
- Report exports in CSV, Excel-compatible, and PDF formats
- Fiscal period creation, close, lock, and reopen flows
- Audit logging for core domain actions
- Dashboard summary endpoints
- Customer and supplier management
- Invoice and bill workflows with journal-entry posting/payment links
- AR/AP aging reports and dashboard AR/AP summaries
- Automated tests plus the supplementary verification script

## Implementation Boundaries

- Audit log immutability is enforced in the current application/model layer; this README does not claim external WORM storage guarantees.
- Redis is not used for browser/server sessions in this codebase.
- Outbound email delivery is not built in. Invite flows return one-time invitation tokens to the authorized inviter, and forgot-password only exposes reset tokens when `EXPOSE_EMAIL_ACTION_TOKENS=true`.
- The verification script is a supplementary regression check, not a replacement for the automated test suite.
- Invoice/bill features do not yet include tax calculation, e-invoicing, recurring invoices, or outbound email delivery.
- Multi-currency, tax engine, billing limits enforcement, OAuth/SSO/2FA, webhooks, and AI features are not implemented in this backend yet.
