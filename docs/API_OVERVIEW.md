# ARA Financial - API Overview

Base URL: `/api/v1`

**Response format** (all endpoints):
```json
{ "success": true|false, "data": {...}, "error": {...}, "meta": {...} }
```

**Authentication:** `Authorization: Bearer <access_token>` on all protected routes.

---

## Auth (`/api/v1/auth`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/register` | Public | Register user + tenant |
| POST | `/login` | Public | Login (rate limited: 5/min/IP via Redis) |
| POST | `/accept-invite` | Public | Activate an invited account with a one-time invitation token |
| POST | `/forgot-password` | Public | Start password reset flow (generic response unless token exposure is enabled) |
| POST | `/reset-password` | Public | Complete password reset with a one-time reset token |
| POST | `/refresh` | Public | Rotate access + refresh tokens |
| POST | `/logout` | Yes | Revoke the supplied refresh token if present |
| GET | `/me` | Yes | Get current user with role info |

## Users (`/api/v1/users`)

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| GET | `/` | `user:read` | List tenant users |
| GET | `/profile` | Any auth | Get own profile |
| PATCH | `/profile` | Any auth | Update name, language |
| GET | `/:id` | `user:read` | Get user by ID |
| POST | `/invite` | `user:invite` | Invite new user |
| PATCH | `/:id/role` | `user:update` | Change user role |
| PATCH | `/:id/deactivate` | `user:deactivate` | Deactivate user |

## Tenants (`/api/v1/tenants`)

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| GET | `/` | `tenant:read` | Get tenant info |
| PATCH | `/settings` | `tenant:update` | Update tenant settings |
| POST | `/complete-setup` | `tenant:update` | Mark setup as complete |

## Chart of Accounts (`/api/v1/accounts`)

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| GET | `/` | `account:read` | List accounts (filter by type, active, search) |
| GET | `/tree` | `account:read` | Hierarchical tree view |
| GET | `/:id` | `account:read` | Get single account |
| POST | `/` | `account:create` | Create account |
| POST | `/template` | `account:create` | Apply Egyptian CoA template |
| PATCH | `/:id` | `account:update` | Update account |
| DELETE | `/:id` | `account:delete` | Soft delete account |

## Fiscal Periods (`/api/v1/fiscal-periods`)

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| GET | `/` | `fiscal:read` | List periods (filter by year) |
| GET | `/:id` | `fiscal:read` | Get period |
| POST | `/` | `fiscal:create` | Create fiscal year (12 monthly periods) |
| POST | `/:id/close` | `fiscal:update` | Close period |
| POST | `/:id/lock` | `fiscal:lock` | Lock period (irreversible) |
| POST | `/:id/reopen` | `fiscal:update` | Reopen closed period |

## Journal Entries (`/api/v1/journal-entries`)

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| POST | `/` | `journal:create` | Create entry (double-entry enforced) |
| GET | `/` | `journal:read` | List entries (filter, search, paginate) |
| GET | `/export` | `report:export` | Export entries to CSV |
| GET | `/:id` | `journal:read` | Get entry with lines |
| PATCH | `/:id` | `journal:update` | Edit draft entry |
| POST | `/:id/post` | `journal:post` | Post entry (makes immutable) |
| POST | `/:id/reverse` | `journal:create` | Create reversing entry |
| DELETE | `/:id` | `journal:delete` | Soft delete draft entry |

## Ledger (`/api/v1/ledger`)

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| GET | `/` | `report:view` | All accounts ledger |
| GET | `/:accountId` | `report:view` | Account ledger with running balance |
| GET | `/:accountId/export` | `report:export` | Export account ledger to CSV |

## Reports (`/api/v1/reports`)

| Method | Endpoint | Permission | Params |
|---|---|---|---|
| GET | `/trial-balance` | `report:view` | `?startDate=&endDate=` |
| GET | `/income-statement` | `report:view` | `?startDate=&endDate=` (required) |
| GET | `/balance-sheet` | `report:view` | `?asOfDate=` (required) |
| GET | `/cash-flow` | `report:view` | `?startDate=&endDate=` (required) |
| GET | `/trial-balance/export` | `report:export` | `?format=csv|excel|pdf` |
| GET | `/income-statement/export` | `report:export` | `?format=csv|excel|pdf` |
| GET | `/balance-sheet/export` | `report:export` | `?format=csv|excel|pdf` |
| GET | `/cash-flow/export` | `report:export` | `?format=csv|excel|pdf` |

## Dashboard (`/api/v1/dashboard`)

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| GET | `/` | `dashboard:view` | Financial summary + entry stats |

## Audit Logs (`/api/v1/audit-logs`)

| Method | Endpoint | Permission | Params |
|---|---|---|---|
| GET | `/` | `audit:read` | `?action=&resourceType=&userId=&startDate=&endDate=` |

## Health (`/api/v1/health`)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/health` | Public | Server status + uptime |
