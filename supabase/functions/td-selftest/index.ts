// TruckDocs end-to-end self-test (development project only).
// Runs real Auth + Storage API calls as throwaway users and reports PASS/FAIL.
// Protected by a one-time token that only the database admin can create. Deleted after use.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

type R = { name: string; result: "PASS" | "FAIL"; detail?: string };

Deno.serve(async (req) => {
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const { data: tok } = await admin.from("selftest_tokens").select("token, used_at, created_at")
    .eq("token", body.token ?? "").maybeSingle();
  if (!tok || tok.used_at || Date.now() - new Date(tok.created_at).getTime() > 15 * 60_000) {
    return new Response(JSON.stringify({ error: "invalid token" }), { status: 403 });
  }
  await admin.from("selftest_tokens").update({ used_at: new Date().toISOString() }).eq("token", tok.token);

  const results: R[] = [];
  const created = { users: [] as string[], companies: [] as string[], files: [] as string[] };
  const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); results.push({ name, result: "PASS" }); }
    catch (e) { results.push({ name, result: "FAIL", detail: String((e as Error).message ?? e) }); }
  };
  const ok = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  const run = crypto.randomUUID().slice(0, 8);
  const mkUser = async (label: string) => {
    const email = `td-${label}-${run}@test.invalid`;
    const password = crypto.randomUUID() + "Aa1!";
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    created.users.push(data.user.id);
    const c = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const s = await c.auth.signInWithPassword({ email, password });
    if (s.error) throw s.error;
    return { id: data.user.id, email, password, c };
  };

  let owner: any, driver: any, driver2: any, ownerB: any, cA = "", cB = "", docId = "", path = "";
  const bytes = new TextEncoder().encode("TruckDocs self-test file " + run);

  await test("Login: accounts sign in with email + password", async () => {
    owner = await mkUser("owner"); driver = await mkUser("driver"); driver2 = await mkUser("driver2"); ownerB = await mkUser("ownerb");
  });
  await test("Login: wrong password is refused", async () => {
    const c = createClient(URL_, ANON, { auth: { persistSession: false } });
    const s = await c.auth.signInWithPassword({ email: owner.email, password: "wrong-password-123" });
    ok(s.error, "wrong password was accepted");
  });
  await test("Owner sign-up flow: create company makes them owner", async () => {
    const a = await owner.c.rpc("create_company", { p_name: "Selftest A " + run, p_full_name: "Owner A", p_language: "en-pa" });
    if (a.error) throw a.error; cA = a.data; created.companies.push(cA);
    const b = await ownerB.c.rpc("create_company", { p_name: "Selftest B " + run, p_full_name: "Owner B" });
    if (b.error) throw b.error; cB = b.data; created.companies.push(cB);
    const m = await owner.c.from("memberships").select("role").eq("company_id", cA).single();
    ok(m.data?.role === "owner", "not owner");
  });
  await test("Driver joins with invite code; second driver joins with another code", async () => {
    const i1 = await owner.c.rpc("create_invite", { p_company: cA }); if (i1.error) throw i1.error;
    const j1 = await driver.c.rpc("accept_invite", { p_code: i1.data, p_full_name: "Driver One" }); if (j1.error) throw j1.error;
    const i2 = await owner.c.rpc("create_invite", { p_company: cA }); if (i2.error) throw i2.error;
    const j2 = await driver2.c.rpc("accept_invite", { p_code: i2.data, p_full_name: "Driver Two" }); if (j2.error) throw j2.error;
    const reuse = await ownerB.c.rpc("accept_invite", { p_code: i1.data, p_full_name: "X" });
    ok(reuse.error, "used code accepted again");
  });
  await test("Driver cannot create invites or change access", async () => {
    const i = await driver.c.rpc("create_invite", { p_company: cA }); ok(i.error, "driver created invite");
    const s = await driver.c.rpc("set_member_active", { p_company: cA, p_user: driver2.id, p_active: false }); ok(s.error, "driver removed someone");
  });
  await test("Storage API: driver uploads a file and confirms it (version 1)", async () => {
    docId = crypto.randomUUID();
    const d = await driver.c.from("documents").insert({ id: docId, company_id: cA, type: "fuel" }); if (d.error) throw d.error;
    path = `${cA}/docs/${docId}/${crypto.randomUUID()}.txt`;
    const u = await driver.c.storage.from("documents").upload(path, bytes, { contentType: "text/plain" }); if (u.error) throw u.error;
    created.files.push(path);
    const v = await driver.c.from("document_versions").insert({ document_id: docId, storage_path: path, sha256: "a".repeat(64) });
    if (v.error) throw v.error;
  });
  await test("Storage API: driver cannot overwrite the file (upsert refused)", async () => {
    const u = await driver.c.storage.from("documents").upload(path, new TextEncoder().encode("tampered"), { upsert: true, contentType: "text/plain" });
    ok(u.error, "overwrite was allowed");
    const dl = await admin.storage.from("documents").download(path);
    ok(dl.data && (await dl.data.text()).startsWith("TruckDocs self-test"), "file content changed");
  });
  await test("Storage API: driver cannot delete the file", async () => {
    await driver.c.storage.from("documents").remove([path]);
    const dl = await admin.storage.from("documents").download(path);
    ok(dl.data && !dl.error, "file was deleted by driver");
  });
  await test("Storage API: owner cannot delete the file either", async () => {
    await owner.c.storage.from("documents").remove([path]);
    const dl = await admin.storage.from("documents").download(path);
    ok(dl.data && !dl.error, "file was deleted by owner");
  });
  await test("Storage API: driver and owner can open the file; other driver and other company cannot", async () => {
    ok(!(await driver.c.storage.from("documents").download(path)).error, "driver cannot open own file");
    ok(!(await owner.c.storage.from("documents").download(path)).error, "owner cannot open file");
    ok((await driver2.c.storage.from("documents").download(path)).error, "other driver opened it");
    ok((await ownerB.c.storage.from("documents").download(path)).error, "other company opened it");
    ok((await driver2.c.storage.from("documents").createSignedUrl(path, 60)).error, "other driver got a share link");
  });
  await test("Storage API: no uploads into another company's folder", async () => {
    const u = await driver.c.storage.from("documents").upload(`${cB}/docs/${crypto.randomUUID()}/x.txt`, bytes);
    ok(u.error, "cross-company upload allowed");
  });
  await test("Investigate: cache window after removal", async () => {
    await driver.c.storage.from("documents").download(path);
    const r = await owner.c.rpc("set_member_active", { p_company: cA, p_user: driver.id, p_active: false }); if (r.error) throw r.error;
    const at0 = !(await driver.c.storage.from("documents").download(path)).error;
    await new Promise((res) => setTimeout(res, 65000));
    const at65 = !(await driver.c.storage.from("documents").download(path)).error;
    const fresh = createClient(URL_, ANON, { auth: { persistSession: false } });
    const s2 = await fresh.auth.signInWithPassword({ email: driver.email, password: driver.password });
    const newSession = s2.error ? "signin failed" : !(await fresh.storage.from("documents").download(path)).error;
    throw new Error("REPORT " + JSON.stringify({ at0, at65, new_session_can_open: newSession }));
  });
  // Clean up files through the Storage API (service role); database rows are removed by the admin afterwards.
  if (created.files.length) await admin.storage.from("documents").remove(created.files);

  const passed = results.filter((r) => r.result === "PASS").length;
  return new Response(JSON.stringify({ passed, total: results.length, results, created }), {
    headers: { "Content-Type": "application/json" },
  });
});
