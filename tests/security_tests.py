#!/usr/bin/env python3
"""TruckDocs Phase 1 security tests.

Runs every permission from an authorized AND an unauthorized account against a real
Postgres database with the migration applied. Prints PASS/FAIL per test and writes
tests/results.md. Exit code 1 if anything fails.

Usage: python3 tests/security_tests.py            (local test database)
"""
import json, os, subprocess, sys, uuid, datetime

DB = os.environ.get("TD_DB", "td_test")
PSQL = ["psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", DB]

results = []

def run_sql(sql):
    p = subprocess.run(PSQL + ["-f", "-"], input=sql, capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()

def admin(sql):
    code, out, err = run_sql(sql)
    if code != 0:
        raise RuntimeError(f"admin SQL failed: {err}\n{sql}")
    return out

def as_user(uid, sql):
    """Run SQL as a signed-in app user (role authenticated) or anon if uid is None."""
    role = "authenticated" if uid else "anon"
    claims = json.dumps({"sub": uid, "role": role}) if uid else ""
    wrapped = (f"begin;\nset local role {role};\n"
               f"set local \"request.jwt.claims\" = '{claims}';\n{sql}\ncommit;\n")
    return run_sql(wrapped)

def ok(uid, sql):
    code, out, err = as_user(uid, sql)
    if code != 0:
        raise AssertionError(f"expected success, got error: {err.splitlines()[-1] if err else err}")
    return out

def denied(uid, sql, must_contain=None):
    code, out, err = as_user(uid, sql)
    if code == 0:
        raise AssertionError(f"expected refusal, but it succeeded (output: {out!r})")
    if must_contain and must_contain.lower() not in err.lower():
        raise AssertionError(f"refused for the wrong reason: {err.splitlines()[-1]}")
    return err

def eq(actual, expected, what=""):
    if str(actual) != str(expected):
        raise AssertionError(f"{what}: expected {expected!r}, got {actual!r}")

def test(group, name):
    def deco(fn):
        try:
            fn()
            results.append((group, name, "PASS", ""))
        except Exception as e:  # noqa
            results.append((group, name, "FAIL", str(e)))
        return fn
    return deco

# --------------------------------------------------------------------------- setup
U = {k: str(uuid.uuid4()) for k in ["ownerA", "driverA", "driverA2", "ownerB", "driverB", "stranger"]}
admin("\n".join(f"insert into auth.users (id, email) values ('{v}', '{k}-{v[:8]}@test.local');" for k, v in U.items()))
S = {}  # shared ids discovered during tests

def upload(uid, path):
    return as_user(uid, f"insert into storage.objects (bucket_id, name) values ('documents', '{path}');")

SHA = "a" * 64
SHA2 = "b" * 64

# --------------------------------------------------------------------------- 1. accounts & companies
@test("Accounts", "Owner A can create a company and becomes its owner")
def _():
    S["A"] = ok(U["ownerA"], "select public.create_company('Dhillon Transport', 'Owner A', 'en-pa');")
    eq(admin(f"select role from public.memberships where company_id='{S['A']}' and user_id='{U['ownerA']}'"), "owner")

@test("Accounts", "Owner B creates a separate company")
def _():
    S["B"] = ok(U["ownerB"], "select public.create_company('Prairie Haulers', 'Owner B');")

@test("Accounts", "Signed-out visitor (anon) cannot read any table")
def _():
    for t in ["companies", "documents", "document_versions", "vehicles", "papers", "audit_log", "profiles"]:
        denied(None, f"select count(*) from public.{t};", "permission denied")

@test("Accounts", "Signed-out visitor cannot create a company")
def _():
    denied(None, "select public.create_company('X Co', 'X');")

@test("Accounts", "Nobody can insert into companies directly (only via create_company)")
def _():
    denied(U["stranger"], f"insert into public.companies (name, created_by) values ('Fake', '{U['stranger']}');", "permission denied")

# --------------------------------------------------------------------------- 2. vehicles
@test("Vehicles", "Owner A can add truck 101 and trailer 205")
def _():
    S["t101"] = ok(U["ownerA"], f"insert into public.vehicles (company_id, kind, unit_number) values ('{S['A']}','truck','101') returning id;")
    S["tr205"] = ok(U["ownerA"], f"insert into public.vehicles (company_id, kind, unit_number) values ('{S['A']}','trailer','205') returning id;")
    S["tB1"] = ok(U["ownerB"], f"insert into public.vehicles (company_id, kind, unit_number) values ('{S['B']}','truck','900') returning id;")

@test("Vehicles", "Owner A cannot add a truck to Company B")
def _():
    denied(U["ownerA"], f"insert into public.vehicles (company_id, kind, unit_number) values ('{S['B']}','truck','666');", "row-level security")

# --------------------------------------------------------------------------- 3. invites
@test("Invites", "Owner A can create an invite code")
def _():
    S["inv1"] = ok(U["ownerA"], f"select public.create_invite('{S['A']}');")
    S["inv2"] = ok(U["ownerA"], f"select public.create_invite('{S['A']}');")
    S["invB"] = ok(U["ownerB"], f"select public.create_invite('{S['B']}');")

@test("Invites", "A stranger cannot create an invite for Company A")
def _():
    denied(U["stranger"], f"select public.create_invite('{S['A']}');", "only an owner")

@test("Invites", "Driver joins with the code; the same code cannot be reused")
def _():
    eq(ok(U["driverA"], f"select public.accept_invite('{S['inv1']}', 'Harpreet S.', 'en-pa');"), S["A"], "joined company")
    denied(U["driverA2"], f"select public.accept_invite('{S['inv1']}', 'Someone');", "not valid")
    ok(U["driverA2"], f"select public.accept_invite('{S['inv2']}', 'Mike T.');")
    ok(U["driverB"], f"select public.accept_invite('{S['invB']}', 'Driver B');")

@test("Invites", "Expired invite code is refused")
def _():
    code = ok(U["ownerA"], f"select public.create_invite('{S['A']}');")
    admin(f"update public.invites set expires_at = now() - interval '1 minute' where code = '{code}';")
    denied(U["stranger"], f"select public.accept_invite('{code}', 'Late');", "expired")

@test("Invites", "A driver cannot create invites")
def _():
    denied(U["driverA"], f"select public.create_invite('{S['A']}');", "only an owner")

@test("Vehicles", "A driver cannot add vehicles")
def _():
    denied(U["driverA"], f"insert into public.vehicles (company_id, kind, unit_number) values ('{S['A']}','truck','777');", "row-level security")

@test("Vehicles", "Driver A sees Company A's trucks only")
def _():
    eq(ok(U["driverA"], "select count(*) from public.vehicles;"), 2, "vehicles visible to driver A")
    eq(ok(U["driverB"], "select count(*) from public.vehicles;"), 1, "vehicles visible to driver B")

# --------------------------------------------------------------------------- 4. documents & files
@test("Documents", "Driver A creates a fuel receipt record for truck 101")
def _():
    S["d1"] = str(uuid.uuid4())
    ok(U["driverA"], f"insert into public.documents (id, company_id, type, truck_id, trailer_id, details) values "
                     f"('{S['d1']}','{S['A']}','fuel','{S['t101']}','{S['tr205']}', '{{\"litres\": 250.2}}');")
    eq(admin(f"select created_by from public.documents where id='{S['d1']}'"), U["driverA"], "created_by")
    eq(admin(f"select current_version from public.documents where id='{S['d1']}'"), 0, "starts unconfirmed")

@test("Documents", "Driver cannot pretend to be someone else (created_by is set by the server)")
def _():
    denied(U["driverA"], f"insert into public.documents (company_id, type, created_by) values ('{S['A']}','fuel','{U['ownerA']}');", "permission denied")

@test("Documents", "Driver A cannot create a document in Company B")
def _():
    denied(U["driverA"], f"insert into public.documents (company_id, type) values ('{S['B']}','fuel');", "row-level security")

@test("Documents", "Driver A cannot file a document under Company B's truck")
def _():
    denied(U["driverA"], f"insert into public.documents (company_id, type, truck_id) values ('{S['A']}','fuel','{S['tB1']}');", "does not belong")

@test("No fake success", "Confirming a version before the file is uploaded is refused")
def _():
    path = f"{S['A']}/docs/{S['d1']}/{uuid.uuid4()}.jpg"
    denied(U["driverA"], f"insert into public.document_versions (document_id, storage_path, sha256) values ('{S['d1']}','{path}','{SHA}');", "file not received")
    eq(admin(f"select current_version from public.documents where id='{S['d1']}'"), 0, "still unconfirmed")

@test("Files", "Driver A uploads the photo into the right folder, then confirms it (version 1)")
def _():
    S["p1"] = f"{S['A']}/docs/{S['d1']}/{uuid.uuid4()}.jpg"
    code, _, err = upload(U["driverA"], S["p1"])
    if code: raise AssertionError(err)
    ok(U["driverA"], f"insert into public.document_versions (document_id, storage_path, sha256, size_bytes, mime_type) values "
                     f"('{S['d1']}','{S['p1']}','{SHA}', 120000, 'image/jpeg');")
    eq(admin(f"select current_version from public.documents where id='{S['d1']}'"), 1, "confirmed as version 1")

@test("Files", "Driver A cannot upload into Company B's folder")
def _():
    code, _, err = upload(U["driverA"], f"{S['B']}/docs/{uuid.uuid4()}/x.jpg")
    if code == 0: raise AssertionError("upload into another company's folder was allowed")

@test("Files", "Driver A2 cannot upload into Driver A's document folder")
def _():
    code, _, _ = upload(U["driverA2"], f"{S['A']}/docs/{S['d1']}/{uuid.uuid4()}.jpg")
    if code == 0: raise AssertionError("upload into another driver's document was allowed")

@test("Files", "Driver cannot overwrite an uploaded file")
def _():
    out = ok(U["driverA"], f"with u as (update storage.objects set metadata='{{\"x\":1}}' where name='{S['p1']}' returning 1) select count(*) from u;")
    eq(out, 0, "rows overwritten")

@test("Files", "Driver cannot delete an uploaded file")
def _():
    out = ok(U["driverA"], f"with d as (delete from storage.objects where name='{S['p1']}' returning 1) select count(*) from d;")
    eq(out, 0, "rows deleted")
    eq(admin(f"select count(*) from storage.objects where name='{S['p1']}'"), 1, "file still exists")

@test("Files", "Owner cannot delete an uploaded file either")
def _():
    out = ok(U["ownerA"], f"with d as (delete from storage.objects where name='{S['p1']}' returning 1) select count(*) from d;")
    eq(out, 0, "rows deleted")

@test("Files", "Driver A and Owner A can open the file; Driver A2, Owner B and Driver B cannot")
def _():
    q = f"select count(*) from storage.objects where name='{S['p1']}';"
    eq(ok(U["driverA"], q), 1, "driver A")
    eq(ok(U["ownerA"], q), 1, "owner A")
    eq(ok(U["driverA2"], q), 0, "driver A2")
    eq(ok(U["ownerB"], q), 0, "owner B")
    eq(ok(U["driverB"], q), 0, "driver B")

@test("Documents", "Drivers see only their own documents; owners see the company's; other companies see nothing")
def _():
    q = f"select count(*) from public.documents where id='{S['d1']}';"
    eq(ok(U["driverA"], q), 1, "driver A"); eq(ok(U["ownerA"], q), 1, "owner A")
    eq(ok(U["driverA2"], q), 0, "driver A2"); eq(ok(U["ownerB"], q), 0, "owner B"); eq(ok(U["driverB"], q), 0, "driver B")

# --------------------------------------------------------------------------- 5. can't delete / can't change history
@test("Permanent records", "Driver cannot delete a submitted document")
def _():
    denied(U["driverA"], f"delete from public.documents where id='{S['d1']}';", "permission denied")

@test("Permanent records", "Owner cannot hard-delete a document (trash only)")
def _():
    denied(U["ownerA"], f"delete from public.documents where id='{S['d1']}';", "permission denied")

@test("Permanent records", "Even the database admin cannot delete a document or a version")
def _():
    code, _, err = run_sql(f"delete from public.documents where id='{S['d1']}';")
    if code == 0: raise AssertionError("admin deleted a document")
    code, _, err = run_sql(f"delete from public.document_versions where document_id='{S['d1']}';")
    if code == 0: raise AssertionError("admin deleted a version")

@test("Permanent records", "Driver cannot edit a document record directly")
def _():
    denied(U["driverA"], f"update public.documents set type='expense' where id='{S['d1']}';", "permission denied")

@test("Permanent records", "Nobody can edit a stored version (driver, owner or admin)")
def _():
    denied(U["driverA"], f"update public.document_versions set sha256='{SHA2}' where document_id='{S['d1']}';", "permission denied")
    denied(U["ownerA"], f"update public.document_versions set sha256='{SHA2}' where document_id='{S['d1']}';", "permission denied")
    code, _, _ = run_sql(f"update public.document_versions set sha256='{SHA2}' where document_id='{S['d1']}';")
    if code == 0: raise AssertionError("admin edited a version")

# --------------------------------------------------------------------------- 6. replace photo
@test("Replace photo", "Replacing a photo creates version 2 and keeps version 1")
def _():
    S["p2"] = f"{S['A']}/docs/{S['d1']}/{uuid.uuid4()}.jpg"
    code, _, err = upload(U["driverA"], S["p2"])
    if code: raise AssertionError(err)
    ok(U["driverA"], f"insert into public.document_versions (document_id, storage_path, sha256) values ('{S['d1']}','{S['p2']}','{SHA2}');")
    eq(admin(f"select string_agg(version_no::text, ',' order by version_no) from public.document_versions where document_id='{S['d1']}'"), "1,2", "versions")
    eq(admin(f"select current_version from public.documents where id='{S['d1']}'"), 2, "owner sees latest")
    eq(ok(U["ownerA"], f"select count(*) from storage.objects where name='{S['p1']}';"), 1, "old photo still viewable")

@test("Replace photo", "Version number cannot be faked by the app")
def _():
    denied(U["driverA"], f"insert into public.document_versions (document_id, storage_path, sha256, version_no) values ('{S['d1']}','x','{SHA}', 99);", "permission denied")

@test("Replace photo", "A version cannot point at another document's file")
def _():
    other = f"{S['A']}/docs/{uuid.uuid4()}/{uuid.uuid4()}.jpg"
    denied(U["driverA"], f"insert into public.document_versions (document_id, storage_path, sha256) values ('{S['d1']}','{other}','{SHA}');", "does not match")

# --------------------------------------------------------------------------- 7. invoices
@test("Invoices", "New invoice starts as Pending; driver cannot set it to Verified")
def _():
    S["inv"] = str(uuid.uuid4())
    ok(U["driverA"], f"insert into public.documents (id, company_id, type, truck_id) values ('{S['inv']}','{S['A']}','invoice','{S['t101']}');")
    p = f"{S['A']}/docs/{S['inv']}/{uuid.uuid4()}.pdf"; upload(U["driverA"], p)
    ok(U["driverA"], f"insert into public.document_versions (document_id, storage_path, sha256) values ('{S['inv']}','{p}','{SHA}');")
    eq(admin(f"select verification from public.documents where id='{S['inv']}'"), "pending", "status")
    denied(U["driverA"], f"insert into public.documents (company_id, type, verification) values ('{S['A']}','invoice','verified');", "permission denied")
    denied(U["driverA"], f"select public.verify_invoice('{S['inv']}');", "only an owner")

@test("Invoices", "Owner verifies the invoice")
def _():
    ok(U["ownerA"], f"select public.verify_invoice('{S['inv']}');")
    eq(admin(f"select verification from public.documents where id='{S['inv']}'"), "verified", "status")

@test("Invoices", "Only invoices can be verified (fuel receipt refused)")
def _():
    denied(U["ownerA"], f"select public.verify_invoice('{S['d1']}');", "only invoices")
    eq(admin(f"select coalesce(verification::text,'none') from public.documents where id='{S['d1']}'"), "none", "fuel has no verification")

@test("Invoices", "Replacing a verified invoice sends it back to Pending")
def _():
    p = f"{S['A']}/docs/{S['inv']}/{uuid.uuid4()}.pdf"; upload(U["driverA"], p)
    ok(U["driverA"], f"insert into public.document_versions (document_id, storage_path, sha256) values ('{S['inv']}','{p}','{SHA2}');")
    eq(admin(f"select verification from public.documents where id='{S['inv']}'"), "pending", "status after replacement")

@test("Invoices", "Owner B cannot verify Company A's invoice")
def _():
    denied(U["ownerB"], f"select public.verify_invoice('{S['inv']}');", "only an owner")

# --------------------------------------------------------------------------- 8. trash
@test("Trash", "Driver cannot move a document to trash; owner can and can restore it")
def _():
    denied(U["driverA"], f"select public.trash_document('{S['d1']}');", "only an owner")
    ok(U["ownerA"], f"select public.trash_document('{S['d1']}');")
    eq(admin(f"select trashed_at is not null from public.documents where id='{S['d1']}'"), "t", "in trash")
    eq(admin(f"select count(*) from public.document_versions where document_id='{S['d1']}'"), 2, "versions kept while in trash")

@test("Trash", "No new versions can be added to a trashed document")
def _():
    p = f"{S['A']}/docs/{S['d1']}/{uuid.uuid4()}.jpg"
    code, _, _ = upload(U["driverA"], p)
    if code == 0: raise AssertionError("upload into trashed document folder was allowed")

@test("Trash", "Owner restores the document")
def _():
    ok(U["ownerA"], f"select public.restore_document('{S['d1']}');")
    eq(admin(f"select trashed_at is null from public.documents where id='{S['d1']}'"), "t", "restored")

# --------------------------------------------------------------------------- 9. details
@test("Details", "Driver can correct details of their own document (logged); other drivers cannot")
def _():
    ok(U["driverA"], f"select public.update_document_details('{S['d1']}', '{{\"litres\": 251.0, \"vendor\": \"Highway 2\"}}');")
    eq(admin(f"select details->>'litres' from public.documents where id='{S['d1']}'"), "251.0", "litres")
    denied(U["driverA2"], f"select public.update_document_details('{S['d1']}', '{{}}');", "not allowed")
    eq(admin(f"select count(*) from public.audit_log where entity_id='{S['d1']}' and action='document.details_changed'"), 1, "logged")

# --------------------------------------------------------------------------- 10. papers
@test("Papers", "Owner uploads insurance for truck 101; drivers cannot create or upload papers")
def _():
    S["paper"] = ok(U["ownerA"], f"insert into public.papers (company_id, vehicle_id, paper_type) values ('{S['A']}','{S['t101']}','insurance') returning id;")
    denied(U["driverA"], f"insert into public.papers (company_id, vehicle_id, paper_type) values ('{S['A']}','{S['t101']}','permit');", "row-level security")
    code, _, _ = upload(U["driverA"], f"{S['A']}/papers/{S['paper']}/{uuid.uuid4()}.pdf")
    if code == 0: raise AssertionError("driver uploaded a paper file")

@test("Papers", "Old and new copies both visible to drivers until the old one expires")
def _():
    paths = []
    for exp in ["current_date + 1", "current_date + 365"]:
        p = f"{S['A']}/papers/{S['paper']}/{uuid.uuid4()}.pdf"
        code, _, err = upload(U["ownerA"], p)
        if code: raise AssertionError(err)
        ok(U["ownerA"], f"insert into public.paper_versions (paper_id, storage_path, expires_on) values ('{S['paper']}','{p}', {exp});")
        paths.append(p)
    # an already-expired copy (inserted as admin to simulate history)
    p = f"{S['A']}/papers/{S['paper']}/{uuid.uuid4()}.pdf"
    admin(f"insert into storage.objects (bucket_id, name) values ('documents','{p}');"
          f"insert into public.paper_versions (paper_id, storage_path, valid_from, expires_on, uploaded_by) "
          f"values ('{S['paper']}','{p}', current_date - 400, current_date - 35, '{U['ownerA']}');")
    eq(ok(U["driverA"], f"select count(*) from public.paper_versions where paper_id='{S['paper']}';"), 2, "driver sees 2 valid copies")
    eq(ok(U["ownerA"], f"select count(*) from public.paper_versions where paper_id='{S['paper']}';"), 3, "owner sees full history")
    eq(ok(U["driverA"], f"select count(*) from storage.objects where name='{p}';"), 0, "expired file hidden from driver")
    eq(ok(U["driverB"], f"select count(*) from public.paper_versions;"), 0, "other company sees none")

@test("Papers", "Paper versions are permanent")
def _():
    denied(U["ownerA"], f"delete from public.paper_versions where paper_id='{S['paper']}';", "permission denied")
    code, _, _ = run_sql(f"delete from public.paper_versions where paper_id='{S['paper']}';")
    if code == 0: raise AssertionError("admin deleted a paper version")

# --------------------------------------------------------------------------- 11. requests
@test("Requests", "Owner requests a BOL from Mike; Mike sees it and fulfils it by sending")
def _():
    S["req"] = ok(U["ownerA"], f"insert into public.document_requests (company_id, driver_id, doc_type, note) values "
                               f"('{S['A']}','{U['driverA2']}','load','BOL for Red Deer') returning id;")
    eq(ok(U["driverA2"], "select count(*) from public.document_requests;"), 1, "Mike sees his request")
    eq(ok(U["driverA"], "select count(*) from public.document_requests;"), 0, "Harpreet does not")
    d = str(uuid.uuid4())
    ok(U["driverA2"], f"insert into public.documents (id, company_id, type, request_id) values ('{d}','{S['A']}','load','{S['req']}');")
    p = f"{S['A']}/docs/{d}/{uuid.uuid4()}.jpg"; upload(U["driverA2"], p)
    ok(U["driverA2"], f"insert into public.document_versions (document_id, storage_path, sha256) values ('{d}','{p}','{SHA}');")
    eq(admin(f"select fulfilled_document_id from public.document_requests where id='{S['req']}'"), d, "fulfilled")

@test("Requests", "Drivers cannot create requests; a driver cannot claim another driver's request")
def _():
    denied(U["driverA"], f"insert into public.document_requests (company_id, driver_id, doc_type) values ('{S['A']}','{U['driverA']}','fuel');", "row-level security")
    denied(U["driverA"], f"insert into public.documents (company_id, type, request_id) values ('{S['A']}','load','{S['req']}');", "does not belong")

# --------------------------------------------------------------------------- 12. feedback & profiles & audit
@test("Feedback", "Driver sends feedback; only they (and our team) can read it, not the owner")
def _():
    ok(U["driverA"], f"insert into public.feedback (company_id, kind, message, screen) values ('{S['A']}','problem','Photo stuck','capture');")
    eq(ok(U["driverA"], "select count(*) from public.feedback;"), 1, "driver")
    eq(ok(U["ownerA"], "select count(*) from public.feedback;"), 0, "owner")

@test("Profiles", "Owner sees drivers' names; drivers cannot see other people's profiles")
def _():
    eq(ok(U["ownerA"], "select count(*) from public.profiles;"), 3, "owner A sees self + 2 drivers")
    eq(ok(U["driverA"], "select count(*) from public.profiles;"), 1, "driver sees only self")

@test("Audit", "Owner can read the company audit log; drivers and other companies cannot; nobody can edit it")
def _():
    n = int(ok(U["ownerA"], "select count(*) from public.audit_log;"))
    if n < 8: raise AssertionError(f"expected many audit entries, got {n}")
    eq(ok(U["driverA"], "select count(*) from public.audit_log;"), 0, "driver")
    eq(ok(U["ownerB"], f"select count(*) from public.audit_log where company_id='{S['A']}';"), 0, "owner B")
    denied(U["ownerA"], "update public.audit_log set action='x';", "permission denied")
    code, _, _ = run_sql("delete from public.audit_log;")
    if code == 0: raise AssertionError("admin deleted audit log")

@test("Server only", "App users cannot read the receipt-reading cache")
def _():
    denied(U["ownerA"], "select count(*) from public.ocr_cache;", "permission denied")

@test("Server only", "Helper functions are not callable by signed-out visitors")
def _():
    denied(None, f"select private.is_owner('{S['A']}');", "permission denied")

# --------------------------------------------------------------------------- 13. removing a driver
@test("Driver leaves", "Owner removes Harpreet: he loses all access immediately; records stay with the company")
def _():
    ok(U["ownerA"], f"select public.set_member_active('{S['A']}','{U['driverA']}', false);")
    eq(ok(U["driverA"], "select count(*) from public.documents;"), 0, "documents after removal")
    eq(ok(U["driverA"], "select count(*) from public.vehicles;"), 0, "vehicles after removal")
    eq(ok(U["driverA"], f"select count(*) from storage.objects where name='{S['p1']}';"), 0, "his old photo after removal")
    denied(U["driverA"], f"insert into public.documents (company_id, type) values ('{S['A']}','fuel');", "row-level security")
    eq(ok(U["ownerA"], f"select count(*) from public.documents where created_by='{U['driverA']}';"), 2, "owner still has his documents")

@test("Driver leaves", "A removed driver cannot rejoin with a new invite code")
def _():
    code = ok(U["ownerA"], f"select public.create_invite('{S['A']}');")
    denied(U["driverA"], f"select public.accept_invite('{code}', 'Harpreet S.');", "removed by the owner")

@test("Driver leaves", "Owner can restore a removed driver")
def _():
    ok(U["ownerA"], f"select public.set_member_active('{S['A']}','{U['driverA']}', true);")
    eq(ok(U["driverA"], "select count(*) from public.vehicles;"), 2, "access back")

@test("Driver leaves", "A company always keeps at least one active owner")
def _():
    denied(U["ownerA"], f"select public.set_member_active('{S['A']}','{U['ownerA']}', false);", "at least one active owner")

@test("Driver leaves", "A driver cannot remove other people")
def _():
    denied(U["driverA2"], f"select public.set_member_active('{S['A']}','{U['driverA']}', false);", "only an owner")

# --------------------------------------------------------------------------- report
passed = sum(1 for r in results if r[2] == "PASS")
lines = [f"# TruckDocs Phase 1 security tests",
         f"Run: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')} on database `{DB}`",
         f"**{passed} of {len(results)} passed**", "",
         "| Area | Test | Result | Detail |", "|---|---|---|---|"]
for g, n, r, d in results:
    lines.append(f"| {g} | {n} | {r} | {d.replace('|', '/')[:160]} |")
open(os.path.join(os.path.dirname(__file__), "results.md"), "w").write("\n".join(lines) + "\n")
for g, n, r, d in results:
    print(f"{r}  [{g}] {n}" + (f"\n      -> {d}" if d else ""))
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
