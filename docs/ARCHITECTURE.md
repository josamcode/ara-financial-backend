# ARA Financial - Architecture

## Module Structure

```text
auth          -> register, login, refresh, logout, invite acceptance, password reset, RBAC
user          -> invite, role change, deactivate, profile
tenant        -> settings, setup
account       -> chart of accounts CRUD, tree, template seeding
fiscal-period -> create year, close, lock, reopen
journal       -> journal entries with double-entry enforcement
ledger        -> general ledger (derived from journal entries)
report        -> trial balance, income statement, balance sheet, cash flow
dashboard     -> financial summary + entry stats
audit         -> immutable audit trail
```

## Request Lifecycle

```text
Client Request
  -> Express parsing (JSON, CORS, Helmet, Compression)
  -> Request Logger (assigns request ID, logs on finish)
  -> Route matching (/api/v1/*)
  -> authenticate middleware (JWT verification -> req.user)
  -> tenantContext middleware (req.tenantId)
  -> authorize middleware (permission check)
  -> validate middleware (Zod schema)
  -> Controller (thin layer)
  -> Service (business logic + invariant enforcement)
  -> Model (Mongoose + tenant plugin + soft delete plugin)
  -> MongoDB
  -> Response (standardized format)
  -> Error Handler (if error thrown at any point)
```

## Auth Flow

```text
Register         -> creates User + Tenant + seeds 3 Roles -> returns JWT access + refresh tokens
Login            -> validates credentials -> Redis login throttling + account lockout checks -> returns tokens
Accept Invite    -> validates one-time invitation token -> activates the account -> returns tokens
Forgot Password  -> generates one-time reset token for active accounts -> returns a generic response by default
Reset Password   -> validates one-time reset token -> updates password -> revokes refresh tokens
Refresh          -> validates refresh token from Redis -> rotates both tokens -> revokes old
Logout           -> revokes refresh token from Redis when one is supplied
```

**Tokens:**
- Access token: JWT signed, 15 min TTL, contains userId/tenantId/roleId/permissions
- Refresh token: JWT signed, 7 days TTL, stored in Redis with SHA-256 hash key

**Rate Limiting / Lockout:**
- Login: 5 attempts per IP per 60 seconds, tracked in Redis
- Successful login clears the IP throttle counter
- Repeated invalid credentials also trigger per-account lockout state

**Email / Action Delivery:**
- The backend does not send outbound email yet.
- Invitation tokens are returned to the authorized inviter.
- Password reset tokens are hidden from the public response unless `EXPOSE_EMAIL_ACTION_TOKENS=true`.

## Tenant Isolation Strategy

### Mechanism: Shared Database, Shared Schema + Mongoose Plugin

Every tenant-scoped collection has a `tenantId` field. The **tenant plugin** (`tenantPlugin.js`) auto-injects `tenantId` filters on Mongoose query operations.

**Security Guarantees:**
1. `tenantId` is required on every document that uses the plugin.
2. Queries auto-filter by `tenantId` at the ORM level unless explicitly bypassed.
3. Cross-tenant access returns 404 (not 403) to avoid confirming existence.
4. System-level queries can bypass with `__skipTenantFilter` option (used only in auth/system flows).

### Which collections use tenant plugin
- Users
- Roles
- Accounts
- JournalEntries
- FiscalPeriods
- AuditLogs

## Accounting Module Design

### Embedded Journal Lines

**Decision:** Journal entry lines are embedded sub-documents inside the journal entry, not a separate collection.

**Why:**
1. **Atomicity**: MongoDB guarantees document-level atomicity. An entry with its lines is always saved completely or not at all.
2. **Read performance**: Fetching an entry always returns its lines in one read.
3. **Consistency**: No multi-document transaction is needed for the single-entry save itself.

**Reporting/Aggregation:**
```text
$match -> $unwind -> $lookup (join accounts) -> $group -> $sort
```

### Balance Enforcement

Uses **BigInt fixed-point arithmetic** (6 decimal places) for balance validation:
```text
String amount -> multiply by 1,000,000 -> BigInt -> sum all debits/credits -> compare
```

## Error Handling Strategy

```text
Custom error classes (AppError hierarchy)
  -> BadRequestError (400)
  -> UnauthorizedError (401)
  -> ForbiddenError (403)
  -> NotFoundError (404)
  -> ConflictError (409)
  -> ValidationError (422)
  -> TooManyRequestsError (429)

Global error middleware catches all errors:
  -> Mongoose ValidationError -> 422
  -> Mongoose duplicate key (11000) -> 409
  -> Mongoose CastError -> 400
  -> JWT errors -> 401
  -> AppError subclasses -> use their statusCode
  -> Unknown errors -> 500 (internals hidden in production)
```

**Response Format:**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human readable message",
    "errors": [{ "field": "email", "message": "Valid email required" }]
  }
}
```

## Config Strategy

- Environment variables loaded via `dotenv` at startup
- Required variables (`MONGODB_URI`, `JWT_SECRET`) validated at boot
- Single config object exported for the entire app
- Duration strings parsed to seconds (`15m` -> `900`)
- Environment variables are used for deployment-specific behavior
