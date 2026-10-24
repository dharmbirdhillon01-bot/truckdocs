# Step 5 — Logins: test record (truckdocs-dev)

Method: Supabase Edge Function `td-selftest` (dev only, one-time-token protected, removed after testing) creates throwaway
accounts and calls the real Auth and Storage APIs exactly as the app does. Triggered from the database with pg_net.

## Run 1 — 2026-10-23 ~20:00 (Edmonton): 14 of 15 PASS

| Test | Result |
|---|---|
| Accounts sign in with email + password | PASS |
| Wrong password refused | PASS |
| Owner creates company and becomes owner | PASS |
| Drivers join with invite codes; used code refused | PASS |
| Driver cannot create invites or change access | PASS |
| Storage API: driver uploads and confirms version 1 | PASS |
| Storage API: driver cannot overwrite (upsert refused, content unchanged) | PASS |
| Storage API: driver cannot delete the file | PASS (closes PARTIAL item 10 from the database tests) |
| Storage API: owner cannot delete the file | PASS |
| Storage API: only the sending driver and owner can open it; others and share links refused | PASS |
| Storage API: no uploads into another company's folder | PASS |
| Driver removed: same session loses documents and files | **FAIL** — database access ended, but the driver could still re-download a file he had already downloaded before removal |
| Driver restored regains access | PASS |
| Signed-out visitor sees nothing | PASS |
| Disabled (banned) login cannot sign in | PASS |

## Investigation of the failure (run 2)
After removal, with the same login session:
- files opened before removal: still downloadable (also with "no-cache" uploads)
- files never opened before: refused
- share links: refused
- uploads: refused
- database rows: none visible

Conclusion: Supabase's file delivery layer caches successful downloads per login token. Supabase docs (Smart CDN) confirm
revoking access does not purge cached entries. Measured duration: see run 3.

## Run 3 — cache window measurement
Removed driver, same login: refused at 0 s, **served again at 65 s** (cache), refused with a new login.
Unpredictable, so not acceptable.

## Fix (2026-10-23)
- Migration 0002: direct read permission on the file bucket removed for all app users.
- New server function `td-file`: every download checks, at that moment, the user's login and the database security rules,
  then returns the file with `Cache-Control: no-store, private`.

## Run 4 — after fix: 15 of 15 PASS
| Test | Result |
|---|---|
| Accounts sign in with email + password | PASS |
| Wrong password refused | PASS |
| Owner creates company and becomes owner | PASS |
| Drivers join with invite codes; used code refused | PASS |
| Driver cannot create invites or change access | PASS |
| Driver uploads and confirms version 1 | PASS |
| Driver cannot overwrite a file | PASS |
| Driver cannot delete a file | PASS |
| Owner cannot delete a file | PASS |
| Direct storage download and share links refused for everyone, driver and owner included | PASS |
| Secure download: driver + owner can open; other driver, other company, signed-out refused | PASS |
| No uploads into another company's folder | PASS |
| Driver removed: refused at once **and 65 s later** with same login, and with a new login; no records, no uploads; owner keeps the record | PASS (was FAIL) |
| Driver restored regains access | PASS |
| Disabled login cannot sign in | PASS |

Step 5 security result: **PASS**. Still to do manually: password-reset email from a real inbox (needs hosted app).
