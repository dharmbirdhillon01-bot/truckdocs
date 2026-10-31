# Step 8 — Owner truck folders, invoice check, trash/restore, drivers add trucks (2026-10-31)

## Database (local Postgres, migrations 0001–0004 + Supabase shim)
New server action `add_unit` (migration 0004). Trash, restore and invoice verify already existed and are
covered by the original security tests ("Invoices" and "Trash" groups — all PASS).

- PASS  Driver adds: Driver adds truck ' 222  a ' — stored cleaned as '222 A', marked as added by the driver
- PASS  Driver adds: Company history records the add with the driver as the one who did it
- PASS  Driver adds: Typing the same number again gives the same truck, no duplicate
- PASS  Driver adds: A trailer can have the same number as a truck (kept separate)
- PASS  Driver limits: Driver still cannot add, rename or delete units directly
- PASS  Driver adds: Number the owner deleted comes back when a driver types it again
- PASS  Driver limits: Other company's driver, a stranger and a signed-out person are refused
- PASS  Driver limits: Removed driver is refused
- PASS  Driver limits: Empty or too-long numbers are refused
- PASS  Owner: Owner can use the same action too
- 10/10 PASS

Regression: original suite 57/59 PASS, identical with and without 0004. The 2 failures ("Files", "Replace photo")
are out-of-date tests: since migration 0002 (Oct 23) files open only through the td-file server function, by design.

## Screens (phone-size browser, fake data, no real accounts)
12/12 PASS: driver "+ Add truck" box, new truck selected after the server confirms, no owner buttons for drivers,
invoice "Needs check" / "Verified" tags, owner truck/trailer filter, verify, trash with confirm, trash view, restore.
No page errors.

Pending: real-phone test on truckdocs-dev.
