# ARA Financial - Future Extension Notes

## How This Backend Is Prepared for Future Phases

### Modular Boundaries
Each module (auth, account, journal, report, etc.) is self-contained with its own model, service, controller, and routes. New modules can be added without modifying existing ones.

### Permission System
The `resource:action` permission model is extensible. To add a new module's permissions:
1. Add constants to `role.model.js` `PERMISSIONS`.
2. Update `DEFAULT_ROLES` or create new roles.
3. Use `authorize(PERMISSIONS.NEW_PERMISSION)` on routes.

### Tenant Plugin
Any new collection can get tenant isolation by applying `tenantPlugin`.

### Audit Trail
The audit service accepts any `action`, `resourceType`, and `resourceId`. New modules can log to it immediately.

---

## What Should Be Added Later

### Phase 2: Multi-Currency
- Add `Currency` model and exchange rate management
- Extend journal lines with `currencyCode`, `fxRate`, `baseAmount` fields
- Modify reporting aggregation to handle base currency conversion

### Phase 2: Tax / VAT Engine
- Add `TaxType` model with configurable rates
- Auto-create tax journal lines on transactions
- VAT return report generation

### Phase 2: OAuth / SSO / 2FA
- Add OAuth strategy to auth module
- TOTP-based 2FA middleware
- SSO via SAML 2.0 (enterprise)

### Phase 3: Approval Workflows
- Extend journal entry status: `draft -> pending -> approved -> posted`
- Add configurable threshold rules
- Notification engine for approval requests

### Phase 3: Invoicing Module
- New `invoice` module with line items
- Auto-generation of journal entries from invoices
- PDF generation service

### Phase 4+: AI Features
- Separate service/module for predictions
- Data pipeline for anonymized training data
- Arabic NLP query interface

---

## Safe Extension Points

| Extension | Where to Modify | Impact |
|---|---|---|
| New API module | Add to `src/modules/`, register in `app.js` | None to existing code |
| New permission | Add to `role.model.js` `PERMISSIONS` | Existing roles unaffected |
| New report | Add method to `report.service.js`, route to `report.routes.js` | None |
| New dashboard card | Add aggregation to `dashboard.service.js` | None |
| Email sending | Replace token-return flows in auth/user services with a real email service | None |
| File uploads | Add multer middleware + S3 service | None |
| WebSocket notifications | Add alongside Express app | None |

---

## Technical Debt / Tradeoffs Accepted in MVP

| Item | Current State | Future Fix |
|---|---|---|
| Report caching | Short-lived Redis caching with request-time invalidation inputs | Add event-driven invalidation for finer-grained cache refresh |
| Email sending | No outbound mailer yet; invite/reset flows rely on returned tokens or generic responses | Integrate SMTP or email service (SendGrid/SES) |
| Rate limiting scope | Login endpoint only | Extend to other sensitive endpoints as needed |
| PDF export | Lightweight tabular PDF export only | Add richer branded PDF generation service |
| File attachments | Schema field exists but no upload logic | Add multer + S3 upload service |
| Running balance calculation | Computed per request with aggregation | Pre-compute and cache for large accounts |
| Session management | JWT only (no browser/server session store) | Add server-side session tracking only if the product needs it |
| Password reset delivery | Reset flow is implemented, but delivery is not email-backed yet | Add mail delivery and self-service reset UI |
| Tenant data export | Not implemented | Add background job to export all tenant data as ZIP |
