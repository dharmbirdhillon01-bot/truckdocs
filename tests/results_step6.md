# Step 6 — Trucks and trailers: test record (truckdocs-dev, 2026-10-23)

Migration 0003_vehicles applied. Database tests ran inside Supabase as real owner/driver/other-company accounts; all rolled back.

| # | Test | Result |
|---|---|---|
| 1 | Owner adds truck " 101 " → stored "101", added-by recorded | PASS |
| 2 | Duplicate truck number refused | PASS |
| 3 | Trailer may share a number with a truck; letters stored in capitals | PASS |
| 4 | Driver sees own company's units | PASS |
| 5 | Driver cannot add units | PASS |
| 6 | Driver cannot rename or retire | PASS |
| 7 | Other company cannot see or change units | PASS |
| 8 | Other company cannot add units to this company | PASS |
| 9 | Truck/trailer type cannot be changed | PASS |
| 10 | Owner cannot delete a unit | PASS |
| 11 | Delete blocked even for the database admin | PASS |
| 12 | History records added / renamed / retired | PASS |

Screen (browser test with a fake server): add, clean-up, duplicate message (number kept in the box),
rename, retire with confirmation, "Show retired", bring back — PASS. Real-phone test: pending.
Not in this step: drivers adding a new truck from their home screen (comes with step 8, owner decides).
