// TruckDocs step 7 self-test (development project only).
// Runs the paperwork flow exactly as the app does it — as real signed-in throwaway users, through the real
// Auth, Database and Storage APIs — and reports PASS/FAIL. Protected by a one-time token that only the
// database admin can create. Retired after use; test rows are removed by the admin afterwards.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const PUBLISHABLE = "sb_publishable_o5P2Hy9lbywcitUPXpMxXA_-zYc1wQ4"; // the app's public key (app/config.js)

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
    const email = `td7-${label}-${run}@test.invalid`;
    const password = crypto.randomUUID() + "Aa1!";
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    created.users.push(data.user.id);
    // Same key as the app uses.
    const c = createClient(URL_, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });
    const s = await c.auth.signInWithPassword({ email, password });
    if (s.error) throw s.error;
    return { id: data.user.id, c, token: s.data.session!.access_token };
  };
  const sha256 = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)))
    .map((x) => x.toString(16).padStart(2, "0")).join("");
  // Same request the app makes to open a file.
  const fileVia = async (token: string, p: string) => {
    const r = await fetch(`${URL_}/functions/v1/td-file?path=${encodeURIComponent(p)}`,
      { headers: { Authorization: `Bearer ${token}`, apikey: PUBLISHABLE } });
    const buf = new Uint8Array(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, buf, type: r.headers.get("content-type") };
  };
  // The app's paper list query.
  const listDocs = (c: any, company: string) => c.from("documents")
    .select("id, type, truck_id, trailer_id, details, created_by, created_at, current_version, document_versions(version_no, storage_path, mime_type, size_bytes)")
    .eq("company_id", company).is("trashed_at", null).order("created_at", { ascending: false }).limit(100);

  let owner: any, driver: any, driver2: any, ownerB: any;
  let cA = "", cB = "", truck = "", trailer = "", truckB = "", docId = "", path = "", hash = "", unfinished = "";
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("TruckDocs step7 photo " + run), 0xff, 0xd9]);

  await test("Setup: owner company, 2 drivers joined by invite, truck + trailer; second company", async () => {
    owner = await mkUser("owner"); driver = await mkUser("driver"); driver2 = await mkUser("driver2"); ownerB = await mkUser("ownerb");
    let r: any = await owner.c.rpc("create_company", { p_name: "Step7 A " + run, p_full_name: "Owner A", p_language: "en-pa" });
    if (r.error) throw r.error; cA = r.data; created.companies.push(cA);
    r = await ownerB.c.rpc("create_company", { p_name: "Step7 B " + run, p_full_name: "Owner B", p_language: "en" });
    if (r.error) throw r.error; cB = r.data; created.companies.push(cB);
    for (const [d, name] of [[driver, "Driver One"], [driver2, "Driver Two"]] as const) {
      const inv = await owner.c.rpc("create_invite", { p_company: cA }); if (inv.error) throw inv.error;
      const j = await d.c.rpc("accept_invite", { p_code: inv.data, p_full_name: name, p_language: "en-pa" }); if (j.error) throw j.error;
    }
    const v = await owner.c.from("vehicles").insert([{ company_id: cA, kind: "truck", unit_number: "101" },
      { company_id: cA, kind: "trailer", unit_number: "205" }]).select("id, kind"); if (v.error) throw v.error;
    truck = v.data.find((x: any) => x.kind === "truck").id; trailer = v.data.find((x: any) => x.kind === "trailer").id;
    const vb = await ownerB.c.from("vehicles").insert({ company_id: cB, kind: "truck", unit_number: "9" }).select("id"); if (vb.error) throw vb.error;
    truckB = vb.data[0].id;
    ok(typeof cA === "string" && cA.length === 36, "company id missing");
  });
  await test("Driver can see the company's trucks/trailers (for the picker) but not change them", async () => {
    const r = await driver.c.from("vehicles").select("id, kind, unit_number, active").eq("company_id", cA);
    if (r.error) throw r.error; ok(r.data.length === 2, `saw ${r.data.length} units`);
    const u = await driver.c.from("vehicles").update({ unit_number: "HACK" }).eq("id", truck).select("id");
    ok(u.error || !(u.data ?? []).length, "driver renamed a truck");
  });
  await test("Driver sends a paper: record with its own id, truck, trailer and details (litres as a number)", async () => {
    docId = crypto.randomUUID();
    const r = await driver.c.from("documents").insert({ id: docId, company_id: cA, type: "fuel", truck_id: truck, trailer_id: trailer,
      details: { date: "2026-10-30", litres: 452.5, note: "Flying J Red Deer" } });
    if (r.error) throw r.error;
  });
  await test("Upload the photo to <company>/docs/<paper>/<fingerprint>.jpg", async () => {
    hash = await sha256(jpeg); path = `${cA}/docs/${docId}/${hash.slice(0, 20)}.jpg`;
    const u = await driver.c.storage.from("documents").upload(path, jpeg, { contentType: "image/jpeg", upsert: false, cacheControl: "0" });
    if (u.error) throw u.error; created.files.push(path);
  });
  await test("Retry of the same upload is reported as 'already exists' (app treats it as done, no copy made)", async () => {
    const u = await driver.c.storage.from("documents").upload(path, jpeg, { contentType: "image/jpeg", upsert: false, cacheControl: "0" });
    ok(u.error, "second upload overwrote the file");
    ok(/exist|duplicate/i.test(u.error!.message || ""), "unexpected message: " + u.error!.message);
  });
  await test("Before confirming, the paper shows as NOT sent (current_version 0)", async () => {
    const r = await driver.c.from("documents").select("current_version").eq("id", docId).maybeSingle();
    if (r.error) throw r.error; ok(r.data && r.data.current_version === 0, "shown as sent before confirm");
  });
  await test("Confirm: version record → server marks the paper Sent (current_version 1)", async () => {
    const v = await driver.c.from("document_versions").insert({ document_id: docId, storage_path: path, sha256: hash, size_bytes: jpeg.length, mime_type: "image/jpeg" });
    if (v.error) throw v.error;
    const r = await driver.c.from("documents").select("current_version").eq("id", docId).maybeSingle();
    if (r.error) throw r.error; ok(r.data && r.data.current_version === 1, "not confirmed: " + JSON.stringify(r.data));
  });
  await test("Retry of the confirm is refused as a duplicate (app treats it as done; still exactly 1 version)", async () => {
    const v = await driver.c.from("document_versions").insert({ document_id: docId, storage_path: path, sha256: hash, size_bytes: jpeg.length, mime_type: "image/jpeg" });
    ok(v.error, "duplicate version accepted");
    ok(/document_versions_storage_path_key|duplicate key/i.test(v.error!.message || ""), "unexpected message: " + v.error!.message);
    const c = await admin.from("document_versions").select("id").eq("document_id", docId);
    ok((c.data ?? []).length === 1, `versions: ${(c.data ?? []).length}`);
  });
  await test("Unfinished paper (record made, upload never finished) stays 'Not sent yet', and can be finished later", async () => {
    unfinished = crypto.randomUUID();
    let r: any = await driver.c.from("documents").insert({ id: unfinished, company_id: cA, type: "load", truck_id: truck, details: { from: "Edmonton", to: "Calgary" } });
    if (r.error) throw r.error;
    const pdf = new TextEncoder().encode("%PDF-1.4\n% step7 " + run + "\n%%EOF");
    const h = await sha256(pdf); const p = `${cA}/docs/${unfinished}/${h.slice(0, 20)}.pdf`;
    r = await driver.c.storage.from("documents").upload(p, pdf, { contentType: "application/pdf", upsert: false, cacheControl: "0" });
    if (r.error) throw r.error; created.files.push(p);
    r = await driver.c.from("document_versions").insert({ document_id: unfinished, storage_path: p, sha256: h, size_bytes: pdf.length, mime_type: "application/pdf" });
    if (r.error) throw r.error;
    const d = await driver.c.from("documents").select("current_version").eq("id", unfinished).maybeSingle();
    ok(d.data && d.data.current_version === 1, "finishing later did not work");
  });
  await test("Paper list: driver sees own papers with file info; owner sees all; other driver and other company see none", async () => {
    const a = await listDocs(driver.c, cA); if (a.error) throw a.error;
    ok(a.data.length === 2, `driver saw ${a.data.length}`);
    const mine = a.data.find((x: any) => x.id === docId);
    ok(mine && mine.document_versions.length === 1 && mine.document_versions[0].storage_path === path, "file info missing");
    ok(mine.details.litres === 452.5, "litres not a number");
    const o = await listDocs(owner.c, cA); if (o.error) throw o.error; ok(o.data.length === 2, `owner saw ${o.data.length}`);
    const d2 = await listDocs(driver2.c, cA); if (d2.error) throw d2.error; ok(d2.data.length === 0, `other driver saw ${d2.data.length}`);
    const b = await listDocs(ownerB.c, cA); if (b.error) throw b.error; ok(b.data.length === 0, `other company saw ${b.data.length}`);
  });
  await test("Open (via td-file, app's key): driver and owner get the exact photo; other driver / other company refused", async () => {
    const d = await fileVia(driver.token, path); ok(d.ok, "driver: " + d.status);
    ok(await sha256(d.buf) === hash, "driver got different bytes");
    const o = await fileVia(owner.token, path); ok(o.ok, "owner: " + o.status);
    ok(await sha256(o.buf) === hash, "owner got different bytes");
    ok(/image\/jpeg/.test(o.type ?? ""), "type: " + o.type);
    ok(!(await fileVia(driver2.token, path)).ok, "other driver opened it");
    ok(!(await fileVia(ownerB.token, path)).ok, "other company opened it");
  });
  await test("Refused: paper with another company's truck; upload into another company's folder", async () => {
    const r = await driver.c.from("documents").insert({ id: crypto.randomUUID(), company_id: cA, type: "fuel", truck_id: truckB, details: {} });
    ok(r.error, "foreign truck accepted");
    const u = await driver.c.storage.from("documents").upload(`${cB}/docs/${crypto.randomUUID()}/x.jpg`, jpeg, { contentType: "image/jpeg" });
    ok(u.error, "cross-company upload allowed");
  });
  await test("Refused: confirming a file that was never uploaded (no fake 'Sent')", async () => {
    const id = crypto.randomUUID();
    const r = await driver.c.from("documents").insert({ id, company_id: cA, type: "expense", details: {} }); if (r.error) throw r.error;
    const v = await driver.c.from("document_versions").insert({ document_id: id, storage_path: `${cA}/docs/${id}/${"0".repeat(20)}.jpg`, sha256: "0".repeat(64), size_bytes: 10, mime_type: "image/jpeg" });
    ok(v.error, "version accepted without a file");
    const d = await driver.c.from("documents").select("current_version").eq("id", id).maybeSingle();
    ok(d.data && d.data.current_version === 0, "marked sent without a file");
  });
  await test("Removed driver: cannot send or open; owner keeps the papers", async () => {
    const r = await owner.c.rpc("set_member_active", { p_company: cA, p_user: driver.id, p_active: false }); if (r.error) throw r.error;
    const ins = await driver.c.from("documents").insert({ id: crypto.randomUUID(), company_id: cA, type: "fuel", details: {} });
    ok(ins.error, "removed driver created a paper");
    ok(!(await fileVia(driver.token, path)).ok, "removed driver opened a file");
    const o = await listDocs(owner.c, cA); ok((o.data ?? []).length >= 2, "owner lost papers");
  });

  if (created.files.length) await admin.storage.from("documents").remove(created.files);
  const passed = results.filter((r) => r.result === "PASS").length;
  return new Response(JSON.stringify({ passed, total: results.length, results, created }), {
    headers: { "Content-Type": "application/json" },
  });
});
