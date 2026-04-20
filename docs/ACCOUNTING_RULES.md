# ARA Financial — Core Accounting Rules

This document defines the **invariants** that the accounting engine enforces at all times. These rules are non-negotiable and protected at both the application and data layers.

---

## 1. Double-Entry: Debit Must Always Equal Credit

Every journal entry must satisfy:

```
sum(debit lines) = sum(credit lines)
```

- Enforced at the **service layer** before writing to the database
- Re-validated at the **model layer** so direct writes cannot persist unbalanced entries
- Uses **BigInt fixed-point arithmetic** (not floating-point) for comparison
- Rejection includes the exact imbalance amount in the error message
- There is no configuration or override for this rule

## 2. Minimum Line Requirements

- Every entry must have **at least 2 lines**
- There must be at least **one debit line** and at least **one credit line**
- Each line must have either a debit amount OR a credit amount — **never both non-zero**

## 3. Posted Entries Are Immutable

Once a journal entry status transitions to `posted`:

- **No field can be modified** — not the date, description, reference, or any line
- **No deletion** — posted entries cannot be soft-deleted
- The only way to correct a posted entry is to create a **reversing entry**

## 4. Reversing Entries for Corrections

To correct a posted entry:

1. A new entry is created with **debits and credits swapped** from the original
2. The reversal entry is automatically posted
3. It is linked to the original via `reversedEntryId`
4. It is marked with `isReversing: true`
5. The original entry remains unchanged

## 5. Draft Entries Can Be Edited

Entries in `draft` status:

- Can have their description, reference, date, and lines modified
- Must still satisfy the double-entry rule after any modification
- Can be soft-deleted (before posting)

## 6. No Operations in Locked Periods

If a fiscal period has status `locked`:

- ❌ Cannot create entries in that period
- ❌ Cannot edit entries in that period
- ❌ Cannot delete entries in that period
- ❌ Cannot post entries in that period
- ✅ Can read/view entries in that period

Closed periods also reject entry creation (must be reopened first).

## 7. No Posting to Frozen or Parent-Only Accounts

- Accounts with `isActive: false` (frozen) cannot receive journal entry lines
- Accounts with `isParentOnly: true` can only have child accounts — they cannot receive direct entries
- System accounts (`systemAccount: true`) cannot be deleted or modified

## 8. Entry Number Integrity

- Entry numbers are auto-generated, **sequential per tenant**
- Entry numbers are **never reused**, even after soft deletion
- Concurrency is handled by an atomic per-tenant counter collection

## 9. Decimal Precision

- All monetary amounts use **Mongoose Decimal128** (128-bit decimal)
- No IEEE 754 floating-point is used for any financial calculation
- Balance validation uses **BigInt arithmetic** with 6-decimal-place precision
- String representation is used at API boundaries to avoid JavaScript number precision loss

## 10. Soft Delete for Financial Data

- Journal entries are never hard-deleted
- Soft-deleted entries retain `deletedAt` timestamp
- Soft-deleted entries are excluded from queries by default
- Soft-deleted entries are included in entry number sequencing (to prevent reuse)
- Soft-deleted entries are included when checking if an account can be deleted

---

## MongoDB-Specific Tradeoffs

| Concern | Approach |
|---|---|
| **ACID transactions** | Document-level atomicity via embedded lines — no multi-document transactions needed for the core write path |
| **Referential integrity** | Enforced at the application layer (account existence validated before saving entry) |
| **Sequential numbering** | Atomic per-tenant counter collection (`findOneAndUpdate`) |
| **Decimal precision** | Decimal128 type provides 34 significant digits |
| **Aggregation** | `$unwind` on embedded lines for ledger/reporting queries |
