# TruckDocs Phase 1 security tests
Run: 2026-10-23 18:15 on database `td_test`
**59 of 59 passed**

| Area | Test | Result | Detail |
|---|---|---|---|
| Accounts | Owner A can create a company and becomes its owner | PASS |  |
| Accounts | Owner B creates a separate company | PASS |  |
| Accounts | Signed-out visitor (anon) cannot read any table | PASS |  |
| Accounts | Signed-out visitor cannot create a company | PASS |  |
| Accounts | Nobody can insert into companies directly (only via create_company) | PASS |  |
| Vehicles | Owner A can add truck 101 and trailer 205 | PASS |  |
| Vehicles | Owner A cannot add a truck to Company B | PASS |  |
| Invites | Owner A can create an invite code | PASS |  |
| Invites | A stranger cannot create an invite for Company A | PASS |  |
| Invites | Driver joins with the code; the same code cannot be reused | PASS |  |
| Invites | Expired invite code is refused | PASS |  |
| Invites | A driver cannot create invites | PASS |  |
| Vehicles | A driver cannot add vehicles | PASS |  |
| Vehicles | Driver A sees Company A's trucks only | PASS |  |
| Documents | Driver A creates a fuel receipt record for truck 101 | PASS |  |
| Documents | Driver cannot pretend to be someone else (created_by is set by the server) | PASS |  |
| Documents | Driver A cannot create a document in Company B | PASS |  |
| Documents | Driver A cannot file a document under Company B's truck | PASS |  |
| No fake success | Confirming a version before the file is uploaded is refused | PASS |  |
| Files | Driver A uploads the photo into the right folder, then confirms it (version 1) | PASS |  |
| Files | Driver A cannot upload into Company B's folder | PASS |  |
| Files | Driver A2 cannot upload into Driver A's document folder | PASS |  |
| Files | Driver cannot overwrite an uploaded file | PASS |  |
| Files | Driver cannot delete an uploaded file | PASS |  |
| Files | Owner cannot delete an uploaded file either | PASS |  |
| Files | Driver A and Owner A can open the file; Driver A2, Owner B and Driver B cannot | PASS |  |
| Documents | Drivers see only their own documents; owners see the company's; other companies see nothing | PASS |  |
| Permanent records | Driver cannot delete a submitted document | PASS |  |
| Permanent records | Owner cannot hard-delete a document (trash only) | PASS |  |
| Permanent records | Even the database admin cannot delete a document or a version | PASS |  |
| Permanent records | Driver cannot edit a document record directly | PASS |  |
| Permanent records | Nobody can edit a stored version (driver, owner or admin) | PASS |  |
| Replace photo | Replacing a photo creates version 2 and keeps version 1 | PASS |  |
| Replace photo | Version number cannot be faked by the app | PASS |  |
| Replace photo | A version cannot point at another document's file | PASS |  |
| Invoices | New invoice starts as Pending; driver cannot set it to Verified | PASS |  |
| Invoices | Owner verifies the invoice | PASS |  |
| Invoices | Only invoices can be verified (fuel receipt refused) | PASS |  |
| Invoices | Replacing a verified invoice sends it back to Pending | PASS |  |
| Invoices | Owner B cannot verify Company A's invoice | PASS |  |
| Trash | Driver cannot move a document to trash; owner can and can restore it | PASS |  |
| Trash | No new versions can be added to a trashed document | PASS |  |
| Trash | Owner restores the document | PASS |  |
| Details | Driver can correct details of their own document (logged); other drivers cannot | PASS |  |
| Papers | Owner uploads insurance for truck 101; drivers cannot create or upload papers | PASS |  |
| Papers | Old and new copies both visible to drivers until the old one expires | PASS |  |
| Papers | Paper versions are permanent | PASS |  |
| Requests | Owner requests a BOL from Mike; Mike sees it and fulfils it by sending | PASS |  |
| Requests | Drivers cannot create requests; a driver cannot claim another driver's request | PASS |  |
| Feedback | Driver sends feedback; only they (and our team) can read it, not the owner | PASS |  |
| Profiles | Owner sees drivers' names; drivers cannot see other people's profiles | PASS |  |
| Audit | Owner can read the company audit log; drivers and other companies cannot; nobody can edit it | PASS |  |
| Server only | App users cannot read the receipt-reading cache | PASS |  |
| Server only | Helper functions are not callable by signed-out visitors | PASS |  |
| Driver leaves | Owner removes Harpreet: he loses all access immediately; records stay with the company | PASS |  |
| Driver leaves | A removed driver cannot rejoin with a new invite code | PASS |  |
| Driver leaves | Owner can restore a removed driver | PASS |  |
| Driver leaves | A company always keeps at least one active owner | PASS |  |
| Driver leaves | A driver cannot remove other people | PASS |  |
