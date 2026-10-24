# Security tests on Supabase project truckdocs-dev (uirbbtlrejbyjknakyin)

Run: 2026-10-23 19:40 (Edmonton). Migration 0001_foundation applied successfully.
Method: tests/remote_tests.sql executed inside the real database as owners, drivers, another company,
a stranger and a signed-out visitor. All test data rolled back afterwards (verified: 0 users, 0 companies,
0 documents, 0 files, 0 audit rows). Test helper schema `td_test` dropped after the run.

**Result: 19 of 20 test groups PASS, 1 PARTIAL.**

| # | Test group | Result |
|---|---|---|
| 1 | Owners create two separate companies | PASS |
| 2 | Signed-out visitor cannot read any table or create a company | PASS |
| 3 | Nobody can insert into companies directly | PASS |
| 4 | Owners add trucks/trailers; cannot add to another company | PASS |
| 5 | Invites: owner only, single use, expired refused | PASS |
| 6 | Drivers cannot add vehicles; see only their company's | PASS |
| 7 | Documents: creator forced by server; no cross-company records or trucks | PASS |
| 8 | No fake success: version refused until the file exists | PASS |
| 9 | No uploads into another company's or another driver's folder | PASS |
| 10 | Files cannot be overwritten or deleted by driver/owner | PARTIAL — overwrite refused by our rules (PASS). Direct delete refused by Supabase's own guard ("Use the Storage API instead"), so our no-delete rule was not reached. Must be re-tested through the Storage API with real signed-in users (step 5/8). |
| 11 | Only the sending driver and the owner can see a document and its file | PASS |
| 12 | Nobody (driver, owner, admin) can delete/edit documents or versions | PASS |
| 13 | Replace photo keeps version 1; numbers/paths cannot be faked | PASS |
| 14 | Invoices: pending → owner verifies → replacement resets; only invoices | PASS |
| 15 | Trash: owner only, versions kept, restore works | PASS |
| 16 | Details correction by own driver, logged | PASS |
| 17 | Papers: owner only; old+new copies until old expires; permanent | PASS |
| 18 | Requests: owner asks, only that driver sees, fulfilled on send | PASS |
| 19 | Feedback/profiles/audit/server-only data private | PASS |
| 20 | Driver removal: instant loss of access, records stay, no rejoin, last owner protected | PASS |

## Supabase security advisor (after migration)
- `ocr_cache` has RLS but no policies — **intended** (server-only table, Phase 3).
- 8 SECURITY DEFINER functions callable by signed-in users (create_company, create_invite, accept_invite,
  set_member_active, verify_invoice, trash_document, restore_document, update_document_details) — **intended**:
  these are the controlled server-side actions; each checks the caller's permission inside and is covered by tests above.
- Test-helper warnings cleared by dropping `td_test`.

## Open items before paying customers
- Storage API delete/overwrite test with real user tokens (item 10).
- Backups: free plan shows "No backups". Production needs Pro (daily backups) + a tested restore.
- Canada data region requires Pro (free plan offers general regions only; dev is us-east-1).
