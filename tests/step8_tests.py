#!/usr/bin/env python3
"""TruckDocs Step 8 tests: drivers add truck/trailer numbers.

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

U = {k: str(uuid.uuid4()) for k in ["owner", "driver", "driver2", "ownerB", "driverB", "stranger"]}
admin("\n".join(f"insert into auth.users (id, email) values ('{v}', '{k}-{v[:8]}@test.local');" for k, v in U.items()))
A = ok(U["owner"], "select public.create_company('Test Co', 'Owner');")
B = ok(U["ownerB"], "select public.create_company('Other Co', 'Owner B');")
for d, co, own in [("driver", A, "owner"), ("driver2", A, "owner"), ("driverB", B, "ownerB")]:
    code = ok(U[own], f"select public.create_invite('{co}');")
    ok(U[d], f"select public.accept_invite('{code}', '{d}');")
S = {}

@test("Driver adds", "Driver adds truck ' 222  a ' — stored cleaned as '222 A', marked as added by the driver")
def _():
    S["t"] = ok(U["driver"], f"select public.add_unit('{A}', 'truck', ' 222  a ');")
    eq(admin(f"select unit_number || '|' || active || '|' || (created_by = '{U['driver']}') from public.vehicles where id = '{S['t']}';"), "222 A|true|true", "row")

@test("Driver adds", "Company history records the add with the driver as the one who did it")
def _():
    eq(admin(f"select count(*) from public.audit_log where entity_id = '{S['t']}' and action = 'vehicle.added' and actor = '{U['driver']}';"), "1", "audit rows")

@test("Driver adds", "Typing the same number again gives the same truck, no duplicate")
def _():
    eq(ok(U["driver2"], f"select public.add_unit('{A}', 'truck', '222 a');"), S["t"], "same id")
    eq(admin(f"select count(*) from public.vehicles where company_id = '{A}' and unit_number = '222 A';"), "1", "rows")

@test("Driver adds", "A trailer can have the same number as a truck (kept separate)")
def _():
    tr = ok(U["driver"], f"select public.add_unit('{A}', 'trailer', '222 A');")
    if tr == S["t"]: raise AssertionError("trailer reused the truck")

@test("Driver limits", "Driver still cannot add, rename or delete units directly")
def _():
    denied(U["driver"], f"insert into public.vehicles (company_id, kind, unit_number) values ('{A}', 'truck', '999');")
    eq(ok(U["driver"], f"with u as (update public.vehicles set unit_number = 'X' where id = '{S['t']}' returning 1) select count(*) from u;"), "0", "renamed rows")
    eq(ok(U["driver"], f"with u as (update public.vehicles set active = false where id = '{S['t']}' returning 1) select count(*) from u;"), "0", "deleted rows")
    denied(U["driver"], f"delete from public.vehicles where id = '{S['t']}';")

@test("Driver adds", "Number the owner deleted comes back when a driver types it again")
def _():
    ok(U["owner"], f"update public.vehicles set active = false where id = '{S['t']}';")
    eq(ok(U["driver"], f"select public.add_unit('{A}', 'truck', '222A ');".replace("222A ", "222 A")), S["t"], "same id")
    eq(admin(f"select active from public.vehicles where id = '{S['t']}';"), "t", "active")

@test("Driver limits", "Other company's driver, a stranger and a signed-out person are refused")
def _():
    denied(U["driverB"], f"select public.add_unit('{A}', 'truck', '555');", "not a member")
    denied(U["stranger"], f"select public.add_unit('{A}', 'truck', '555');", "not a member")
    denied(None, f"select public.add_unit('{A}', 'truck', '555');")
    eq(admin(f"select count(*) from public.vehicles where unit_number = '555';"), "0", "rows")

@test("Driver limits", "Removed driver is refused")
def _():
    ok(U["owner"], f"select public.set_member_active('{A}', '{U['driver2']}', false);")
    denied(U["driver2"], f"select public.add_unit('{A}', 'truck', '556');", "not a member")

@test("Driver limits", "Empty or too-long numbers are refused")
def _():
    denied(U["driver"], f"select public.add_unit('{A}', 'truck', '   ');", "1 to 20")
    denied(U["driver"], f"select public.add_unit('{A}', 'truck', '{'9'*21}');", "1 to 20")

@test("Owner", "Owner can use the same action too")
def _():
    ok(U["owner"], f"select public.add_unit('{A}', 'truck', '777');")

passed = sum(1 for r in results if r[2] == "PASS")
for g, n, r, why in results:
    print(f"{r}  {g}: {n}" + (f"  -- {why}" if why else ""))
print(f"{passed}/{len(results)} PASS")
sys.exit(0 if passed == len(results) else 1)
