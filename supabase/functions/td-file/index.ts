// TruckDocs secure file download.
// Users cannot read the storage bucket directly. Every download comes here, where we check — at that moment, using the
// user's own login and the database's security rules — that they may still see the record pointing at the file.
// The file is returned with no-store so no cache can serve it again after access is removed.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const deny = (status: number, msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET") return deny(405, "method not allowed");
  const auth = req.headers.get("Authorization") ?? "";
  const path = new URL(req.url).searchParams.get("path") ?? "";
  if (!auth.startsWith("Bearer ") || !path || path.includes("..")) return deny(400, "bad request");

  // The caller's own client: every query below is limited by Row Level Security for this user.
  const user = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: who, error: whoErr } = await user.auth.getUser();
  if (whoErr || !who?.user) return deny(401, "sign in required");

  const [v, pv] = await Promise.all([
    user.from("document_versions").select("id").eq("storage_path", path).maybeSingle(),
    user.from("paper_versions").select("id").eq("storage_path", path).maybeSingle(),
  ]);
  if (!(v.data || pv.data)) return deny(404, "not found or no access");   // same answer for both, reveals nothing

  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  const { data: file, error } = await admin.storage.from("documents").download(path);
  if (error || !file) return deny(404, "file missing");
  return new Response(file, {
    headers: { ...CORS, "Content-Type": file.type || "application/octet-stream", "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" },
  });
});
