-- TruckDocs security tests that run INSIDE the real Supabase database.
-- Everything happens in one DO block that ends by raising its report as an error,
-- so all test data (users, companies, files) is rolled back automatically.
create schema if not exists td_test;
grant usage on schema td_test to anon, authenticated;

create or replace function td_test.act(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', case when uid is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.jwt.claims',
    case when uid is null then '' else json_build_object('sub', uid, 'role', 'authenticated')::text end, true);
end $$;
create or replace function td_test.admin() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create or replace function td_test.q(sql text) returns text language plpgsql as $$
declare v text; begin execute sql into v; return v; end $$;
-- returns null if refused for the right reason, otherwise a description of what went wrong
create or replace function td_test.refused(sql text, pat text default null) returns text language plpgsql as $$
begin
  execute sql;
  return 'NOT REFUSED: ' || left(sql, 80);
exception when others then
  if pat is null or sqlerrm ilike '%' || pat || '%' then return null; end if;
  return 'refused for wrong reason: ' || sqlerrm;
end $$;
create or replace function td_test.chk(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is distinct from true then raise exception 'CHECK FAILED: %', msg; end if; end $$;
create or replace function td_test.must(x text) returns void language plpgsql as $$
begin if x is not null then raise exception '%', x; end if; end $$;
grant execute on all functions in schema td_test to anon, authenticated;

do $test$
declare
  oA uuid := gen_random_uuid(); dA uuid := gen_random_uuid(); dA2 uuid := gen_random_uuid();
  oB uuid := gen_random_uuid(); dB uuid := gen_random_uuid(); st uuid := gen_random_uuid();
  cA uuid; cB uuid; t101 uuid; tr205 uuid; tB uuid; inv1 text; inv2 text; invB text; vcode text;
  d1 uuid := gen_random_uuid(); inv uuid := gen_random_uuid(); dreq uuid := gen_random_uuid();
  p1 text; p2 text; pth text; paper uuid; req uuid;
  sha1 text := repeat('a', 64); sha2 text := repeat('b', 64);
  rpt text := ''; n_pass int := 0; n_fail int := 0; tname text;
begin
  insert into auth.users (id, email, aud, role) values
    (oA, 'ownerA-' || left(oA::text, 8) || '@test.invalid', 'authenticated', 'authenticated'),
    (dA, 'driverA-' || left(dA::text, 8) || '@test.invalid', 'authenticated', 'authenticated'),
    (dA2, 'driverA2-' || left(dA2::text, 8) || '@test.invalid', 'authenticated', 'authenticated'),
    (oB, 'ownerB-' || left(oB::text, 8) || '@test.invalid', 'authenticated', 'authenticated'),
    (dB, 'driverB-' || left(dB::text, 8) || '@test.invalid', 'authenticated', 'authenticated'),
    (st, 'stranger-' || left(st::text, 8) || '@test.invalid', 'authenticated', 'authenticated');

  -- 1 ---------------------------------------------------------------------
  tname := 'Accounts: owners create two separate companies';
  begin
    perform td_test.act(oA); cA := public.create_company('Dhillon Transport', 'Owner A', 'en-pa');
    perform td_test.act(oB); cB := public.create_company('Prairie Haulers', 'Owner B');
    perform td_test.admin();
    perform td_test.chk((select role::text from public.memberships where company_id = cA and user_id = oA) = 'owner', 'owner role');
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  tname := 'Accounts: signed-out visitor cannot read any table or create a company';
  begin
    perform td_test.act(null);
    perform td_test.must(td_test.refused('select count(*) from public.companies', 'permission denied'));
    perform td_test.must(td_test.refused('select count(*) from public.documents', 'permission denied'));
    perform td_test.must(td_test.refused('select count(*) from public.document_versions', 'permission denied'));
    perform td_test.must(td_test.refused('select count(*) from public.audit_log', 'permission denied'));
    perform td_test.must(td_test.refused('select count(*) from public.profiles', 'permission denied'));
    perform td_test.must(td_test.refused($q$select public.create_company('X Co','X')$q$, null));
    perform td_test.admin();
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  tname := 'Accounts: nobody can insert into companies directly';
  begin
    perform td_test.act(st);
    perform td_test.must(td_test.refused(format($q$insert into public.companies (name, created_by) values ('Fake', %L)$q$, st), 'permission denied'));
    perform td_test.admin();
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- 2 ---------------------------------------------------------------------
  tname := 'Vehicles: owners add trucks/trailers; owner A cannot add to company B';
  begin
    perform td_test.act(oA);
    insert into public.vehicles (company_id, kind, unit_number) values (cA, 'truck', '101') returning id into t101;
    insert into public.vehicles (company_id, kind, unit_number) values (cA, 'trailer', '205') returning id into tr205;
    perform td_test.must(td_test.refused(format($q$insert into public.vehicles (company_id, kind, unit_number) values (%L,'truck','666')$q$, cB), 'row-level security'));
    perform td_test.act(oB);
    insert into public.vehicles (company_id, kind, unit_number) values (cB, 'truck', '900') returning id into tB;
    perform td_test.admin();
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- 3 ---------------------------------------------------------------------
  tname := 'Invites: owner invites; stranger/driver cannot invite; code single-use; expired refused';
  begin
    perform td_test.act(oA); inv1 := public.create_invite(cA); inv2 := public.create_invite(cA);
    perform td_test.act(oB); invB := public.create_invite(cB);
    perform td_test.act(st);
    perform td_test.must(td_test.refused(format('select public.create_invite(%L)', cA), 'only an owner'));
    perform td_test.act(dA);
    perform td_test.chk(public.accept_invite(inv1, 'Harpreet S.', 'en-pa') = cA, 'driver A joined');
    perform td_test.must(td_test.refused(format('select public.create_invite(%L)', cA), 'only an owner'));
    perform td_test.act(dA2);
    perform td_test.must(td_test.refused(format($q$select public.accept_invite(%L, 'Someone')$q$, inv1), 'not valid'));
    perform public.accept_invite(inv2, 'Mike T.');
    perform td_test.act(dB); perform public.accept_invite(invB, 'Driver B');
    perform td_test.act(oA); vcode := public.create_invite(cA);
    perform td_test.admin(); update public.invites set expires_at = now() - interval '1 minute' where invites.code = vcode;
    perform td_test.act(st);
    perform td_test.must(td_test.refused(format($q$select public.accept_invite(%L, 'Late')$q$, vcode), 'expired'));
    perform td_test.admin();
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  tname := 'Vehicles: drivers cannot add vehicles and see only their company''s';
  begin
    perform td_test.act(dA);
    perform td_test.must(td_test.refused(format($q$insert into public.vehicles (company_id, kind, unit_number) values (%L,'truck','777')$q$, cA), 'row-level security'));
    perform td_test.chk(td_test.q('select count(*) from public.vehicles') = '2', 'driver A sees 2');
    perform td_test.act(dB);
    perform td_test.chk(td_test.q('select count(*) from public.vehicles') = '1', 'driver B sees 1');
    perform td_test.admin();
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- 4 ---------------------------------------------------------------------
  tname := 'Documents: driver creates record; created_by forced; cannot use company B or B''s truck';
  begin
    perform td_test.act(dA);
    insert into public.documents (id, company_id, type, truck_id, trailer_id, details) values (d1, cA, 'fuel', t101, tr205, '{"litres":250.2}');
    perform td_test.must(td_test.refused(format($q$insert into public.documents (company_id, type, created_by) values (%L,'fuel',%L)$q$, cA, oA), 'permission denied'));
    perform td_test.must(td_test.refused(format($q$insert into public.documents (company_id, type) values (%L,'fuel')$q$, cB), 'row-level security'));
    perform td_test.must(td_test.refused(format($q$insert into public.documents (company_id, type, truck_id) values (%L,'fuel',%L)$q$, cA, tB), 'does not belong'));
    perform td_test.admin();
    perform td_test.chk((select created_by from public.documents where id = d1) = dA, 'created_by');
    perform td_test.chk((select current_version from public.documents where id = d1) = 0, 'starts unconfirmed');
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  tname := 'No fake success: version refused until the file exists; then version 1 confirmed';
  begin
    p1 := cA || '/docs/' || d1 || '/' || gen_random_uuid() || '.jpg';
    perform td_test.act(dA);
    perform td_test.must(td_test.refused(format($q$insert into public.document_versions (document_id, storage_path, sha256) values (%L,%L,%L)$q$, d1, p1, sha1), 'file not received'));
    insert into storage.objects (bucket_id, name) values ('documents', p1);
    insert into public.document_versions (document_id, storage_path, sha256, size_bytes, mime_type) values (d1, p1, sha1, 120000, 'image/jpeg');
    perform td_test.admin();
    perform td_test.chk((select current_version from public.documents where id = d1) = 1, 'version 1');
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  tname := 'Files: no upload into company B or another driver''s document';
  begin
    perform td_test.act(dA);
    perform td_test.must(td_test.refused(format($q$insert into storage.objects (bucket_id, name) values ('documents', %L)$q$, cB || '/docs/' || gen_random_uuid() || '/x.jpg'), null));
    perform td_test.act(dA2);
    perform td_test.must(td_test.refused(format($q$insert into storage.objects (bucket_id, name) values ('documents', %L)$q$, cA || '/docs/' || d1 || '/' || gen_random_uuid() || '.jpg'), null));
    perform td_test.admin();
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  tname := 'Files: driver and owner cannot overwrite or delete a stored file';
  begin
    perform td_test.act(dA);
    perform td_test.chk(td_test.q(format($q$with u as (update storage.objects set metadata='{"x":1}' where name=%L returning 1) select count(*) from u$q$, p1)) = '0', 'driver overwrite');
    perform td_test.chk(td_test.q(format($q$with d as (delete from storage.objects where name=%L returning 1) select count(*) from d$q$, p1)) = '0', 'driver delete');
    perform td_test.act(oA);
    perform td_test.chk(td_test.q(format($q$with d as (delete from storage.objects where name=%L returning 1) select count(*) from d$q$, p1)) = '0', 'owner delete');
    perform td_test.admin();
    perform td_test.chk((select count(*) from storage.objects where name = p1) = 1, 'file still there');
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  tname := 'Visibility: only driver A and owner A see the document and its file';
  begin
    perform td_test.act(dA);  perform td_test.chk(td_test.q(format('select count(*) from storage.objects where name=%L', p1)) = '1', 'driver A file');
                              perform td_test.chk(td_test.q(format('select count(*) from public.documents where id=%L', d1)) = '1', 'driver A doc');
    perform td_test.act(oA);  perform td_test.chk(td_test.q(format('select count(*) from storage.objects where name=%L', p1)) = '1', 'owner A file');
    perform td_test.act(dA2); perform td_test.chk(td_test.q(format('select count(*) from storage.objects where name=%L', p1)) = '0', 'driver A2 file');
                              perform td_test.chk(td_test.q(format('select count(*) from public.documents where id=%L', d1)) = '0', 'driver A2 doc');
    perform td_test.act(oB);  perform td_test.chk(td_test.q(format('select count(*) from storage.objects where name=%L', p1)) = '0', 'owner B file');
                              perform td_test.chk(td_test.q(format('select count(*) from public.documents where id=%L', d1)) = '0', 'owner B doc');
    perform td_test.act(dB);  perform td_test.chk(td_test.q(format('select count(*) from storage.objects where name=%L', p1)) = '0', 'driver B file');
    perform td_test.admin();
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- 5 ---------------------------------------------------------------------
  tname := 'Permanent: drivers/owners cannot delete or edit documents or versions; admin cannot either';
  begin
    perform td_test.act(dA);
    perform td_test.must(td_test.refused(format('delete from public.documents where id=%L', d1), 'permission denied'));
    perform td_test.must(td_test.refused(format($q$update public.documents set type='expense' where id=%L$q$, d1), 'permission denied'));
    perform td_test.must(td_test.refused(format('update public.document_versions set sha256=%L where document_id=%L', sha2, d1), 'permission denied'));
    perform td_test.act(oA);
    perform td_test.must(td_test.refused(format('delete from public.documents where id=%L', d1), 'permission denied'));
    perform td_test.must(td_test.refused(format('update public.document_versions set sha256=%L where document_id=%L', sha2, d1), 'permission denied'));
    perform td_test.admin();
    perform td_test.must(td_test.refused(format('delete from public.documents where id=%L', d1), 'permanent'));
    perform td_test.must(td_test.refused(format('delete from public.document_versions where document_id=%L', d1), 'permanent'));
    perform td_test.must(td_test.refused(format('update public.document_versions set sha256=%L where document_id=%L', sha2, d1), 'permanent'));
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- 6 ---------------------------------------------------------------------
  tname := 'Replace photo: version 2 added, version 1 kept and viewable; numbers and paths cannot be faked';
  begin
    p2 := cA || '/docs/' || d1 || '/' || gen_random_uuid() || '.jpg';
    perform td_test.act(dA);
    insert into storage.objects (bucket_id, name) values ('documents', p2);
    insert into public.document_versions (document_id, storage_path, sha256) values (d1, p2, sha2);
    perform td_test.must(td_test.refused(format('insert into public.document_versions (document_id, storage_path, sha256, version_no) values (%L,%L,%L,99)', d1, 'x', sha1), 'permission denied'));
    perform td_test.must(td_test.refused(format('insert into public.document_versions (document_id, storage_path, sha256) values (%L,%L,%L)', d1, cA || '/docs/' || gen_random_uuid() || '/z.jpg', sha1), 'does not match'));
    perform td_test.act(oA);
    perform td_test.chk(td_test.q(format('select count(*) from storage.objects where name=%L', p1)) = '1', 'old photo viewable');
    perform td_test.admin();
    perform td_test.chk((select string_agg(version_no::text, ',' order by version_no) from public.document_versions where document_id = d1) = '1,2', 'versions 1,2');
    perform td_test.chk((select current_version from public.documents where id = d1) = 2, 'latest is 2');
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- 7 ---------------------------------------------------------------------
  tname := 'Invoices: pending by default; only owner verifies; only invoices; replacement resets; owner B refused';
  begin
    perform td_test.act(dA);
    insert into public.documents (id, company_id, type, truck_id) values (inv, cA, 'invoice', t101);
    pth := cA || '/docs/' || inv || '/' || gen_random_uuid() || '.pdf';
    insert into storage.objects (bucket_id, name) values ('documents', pth);
    insert into public.document_versions (document_id, storage_path, sha256) values (inv, pth, sha1);
    perform td_test.must(td_test.refused(format($q$insert into public.documents (company_id, type, verification) values (%L,'invoice','verified')$q$, cA), 'permission denied'));
    perform td_test.must(td_test.refused(format('select public.verify_invoice(%L)', inv), 'only an owner'));
    perform td_test.admin();
    perform td_test.chk((select verification::text from public.documents where id = inv) = 'pending', 'pending');
    perform td_test.act(oA); perform public.verify_invoice(inv);
    perform td_test.must(td_test.refused(format('select public.verify_invoice(%L)', d1), 'only invoices'));
    perform td_test.act(oB);
    perform td_test.must(td_test.refused(format('select public.verify_invoice(%L)', inv), 'only an owner'));
    perform td_test.admin();
    perform td_test.chk((select verification::text from public.documents where id = inv) = 'verified', 'verified');
    perform td_test.act(dA);
    pth := cA || '/docs/' || inv || '/' || gen_random_uuid() || '.pdf';
    insert into storage.objects (bucket_id, name) values ('documents', pth);
    insert into public.document_versions (document_id, storage_path, sha256) values (inv, pth, sha2);
    perform td_test.admin();
    perform td_test.chk((select verification::text from public.documents where id = inv) = 'pending', 'back to pending');
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- 8 ---------------------------------------------------------------------
  tname := 'Trash: driver cannot trash; owner trashes (versions kept, no new uploads) and restores';
  begin
    perform td_test.act(dA);
    perform td_test.must(td_test.refused(format('select public.trash_document(%L)', d1), 'only an owner'));
    perform td_test.act(oA); perform public.trash_document(d1);
    perform td_test.act(dA);
    perform td_test.must(td_test.refused(format($q$insert into storage.objects (bucket_id, name) values ('documents', %L)$q$, cA || '/docs/' || d1 || '/' || gen_random_uuid() || '.jpg'), null));
    perform td_test.admin();
    perform td_test.chk((select count(*) from public.document_versions where document_id = d1) = 2, 'versions kept');
    perform td_test.act(oA); perform public.restore_document(d1);
    perform td_test.admin();
    perform td_test.chk((select trashed_at is null from public.documents where id = d1), 'restored');
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  tname := 'Details: driver corrects own document (logged); other driver refused';
  begin
    perform td_test.act(dA); perform public.update_document_details(d1, '{"litres":251.0}');
    perform td_test.act(dA2);
    perform td_test.must(td_test.refused(format($q$select public.update_document_details(%L,'{}')$q$, d1), 'not allowed'));
    perform td_test.admin();
    perform td_test.chk((select details->>'litres' from public.documents where id = d1) = '251.0', 'litres updated');
    perform td_test.chk((select count(*) from public.audit_log where entity_id = d1 and action = 'document.details_changed') = 1, 'logged');
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- 9 ---------------------------------------------------------------------
  tname := 'Papers: owner only; old+new copies visible to drivers until old expires; expired hidden; permanent';
  begin
    perform td_test.act(oA);
    insert into public.papers (company_id, vehicle_id, paper_type) values (cA, t101, 'insurance') returning id into paper;
    pth := cA || '/papers/' || paper || '/' || gen_random_uuid() || '.pdf';
    insert into storage.objects (bucket_id, name) values ('documents', pth);
    insert into public.paper_versions (paper_id, storage_path, expires_on) values (paper, pth, current_date + 1);
    pth := cA || '/papers/' || paper || '/' || gen_random_uuid() || '.pdf';
    insert into storage.objects (bucket_id, name) values ('documents', pth);
    insert into public.paper_versions (paper_id, storage_path, expires_on) values (paper, pth, current_date + 365);
    perform td_test.act(dA);
    perform td_test.must(td_test.refused(format($q$insert into public.papers (company_id, vehicle_id, paper_type) values (%L,%L,'permit')$q$, cA, t101), 'row-level security'));
    perform td_test.must(td_test.refused(format($q$insert into storage.objects (bucket_id, name) values ('documents', %L)$q$, cA || '/papers/' || paper || '/' || gen_random_uuid() || '.pdf'), null));
    perform td_test.admin();
    pth := cA || '/papers/' || paper || '/' || gen_random_uuid() || '.pdf';
    insert into storage.objects (bucket_id, name) values ('documents', pth);
    insert into public.paper_versions (paper_id, storage_path, valid_from, expires_on, uploaded_by) values (paper, pth, current_date - 400, current_date - 35, oA);
    perform td_test.act(dA);
    perform td_test.chk(td_test.q(format('select count(*) from public.paper_versions where paper_id=%L', paper)) = '2', 'driver sees 2 valid copies');
    perform td_test.chk(td_test.q(format('select count(*) from storage.objects where name=%L', pth)) = '0', 'expired file hidden');
    perform td_test.act(oA);
    perform td_test.chk(td_test.q(format('select count(*) from public.paper_versions where paper_id=%L', paper)) = '3', 'owner sees 3');
    perform td_test.must(td_test.refused(format('delete from public.paper_versions where paper_id=%L', paper), 'permission denied'));
    perform td_test.act(dB);
    perform td_test.chk(td_test.q('select count(*) from public.paper_versions') = '0', 'company B sees none');
    perform td_test.admin();
    perform td_test.must(td_test.refused(format('delete from public.paper_versions where paper_id=%L', paper), 'permanent'));
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- 10 --------------------------------------------------------------------
  tname := 'Requests: owner asks Mike; only Mike sees it; sending fulfils it; drivers cannot create or hijack requests';
  begin
    perform td_test.act(oA);
    insert into public.document_requests (company_id, driver_id, doc_type, note) values (cA, dA2, 'load', 'BOL for Red Deer') returning id into req;
    perform td_test.act(dA2); perform td_test.chk(td_test.q('select count(*) from public.document_requests') = '1', 'Mike sees it');
    insert into public.documents (id, company_id, type, request_id) values (dreq, cA, 'load', req);
    pth := cA || '/docs/' || dreq || '/' || gen_random_uuid() || '.jpg';
    insert into storage.objects (bucket_id, name) values ('documents', pth);
    insert into public.document_versions (document_id, storage_path, sha256) values (dreq, pth, sha1);
    perform td_test.act(dA);
    perform td_test.chk(td_test.q('select count(*) from public.document_requests') = '0', 'Harpreet does not');
    perform td_test.must(td_test.refused(format($q$insert into public.document_requests (company_id, driver_id, doc_type) values (%L,%L,'fuel')$q$, cA, dA), 'row-level security'));
    perform td_test.must(td_test.refused(format($q$insert into public.documents (company_id, type, request_id) values (%L,'load',%L)$q$, cA, req), 'does not belong'));
    perform td_test.admin();
    perform td_test.chk((select fulfilled_document_id from public.document_requests where id = req) = dreq, 'fulfilled');
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- 11 --------------------------------------------------------------------
  tname := 'Feedback, profiles, audit log and server-only data are private';
  begin
    perform td_test.act(dA);
    insert into public.feedback (company_id, kind, message, screen) values (cA, 'problem', 'Photo stuck', 'capture');
    perform td_test.chk(td_test.q('select count(*) from public.feedback') = '1', 'driver reads own feedback');
    perform td_test.chk(td_test.q('select count(*) from public.profiles') = '1', 'driver sees only own profile');
    perform td_test.chk(td_test.q('select count(*) from public.audit_log') = '0', 'driver cannot read audit');
    perform td_test.act(oA);
    perform td_test.chk(td_test.q('select count(*) from public.feedback') = '0', 'owner cannot read driver feedback');
    perform td_test.chk(td_test.q('select count(*) from public.profiles') = '3', 'owner sees self + 2 drivers');
    perform td_test.chk(td_test.q('select count(*) from public.audit_log')::int >= 8, 'owner reads audit');
    perform td_test.must(td_test.refused($q$update public.audit_log set action='x'$q$, 'permission denied'));
    perform td_test.must(td_test.refused('select count(*) from public.ocr_cache', 'permission denied'));
    perform td_test.act(oB);
    perform td_test.chk(td_test.q(format('select count(*) from public.audit_log where company_id=%L', cA)) = '0', 'owner B cannot read A audit');
    perform td_test.act(null);
    perform td_test.must(td_test.refused(format('select private.is_owner(%L)', cA), 'permission denied'));
    perform td_test.admin();
    perform td_test.must(td_test.refused('delete from public.audit_log', 'permanent'));
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- 12 --------------------------------------------------------------------
  tname := 'Driver leaves: access gone instantly, records stay, cannot rejoin, owner can restore, last owner protected';
  begin
    perform td_test.act(oA); perform public.set_member_active(cA, dA, false);
    perform td_test.act(dA);
    perform td_test.chk(td_test.q('select count(*) from public.documents') = '0', 'no documents');
    perform td_test.chk(td_test.q('select count(*) from public.vehicles') = '0', 'no vehicles');
    perform td_test.chk(td_test.q(format('select count(*) from storage.objects where name=%L', p1)) = '0', 'no old photo');
    perform td_test.must(td_test.refused(format($q$insert into public.documents (company_id, type) values (%L,'fuel')$q$, cA), 'row-level security'));
    perform td_test.act(oA);
    perform td_test.chk(td_test.q(format('select count(*) from public.documents where created_by=%L', dA)) = '2', 'owner keeps his records');
    vcode := public.create_invite(cA);
    perform td_test.act(dA);
    perform td_test.must(td_test.refused(format($q$select public.accept_invite(%L,'Harpreet S.')$q$, vcode), 'removed by the owner'));
    perform td_test.act(dA2);
    perform td_test.must(td_test.refused(format('select public.set_member_active(%L,%L,false)', cA, dA), 'only an owner'));
    perform td_test.act(oA);
    perform public.set_member_active(cA, dA, true);
    perform td_test.must(td_test.refused(format('select public.set_member_active(%L,%L,false)', cA, oA), 'at least one active owner'));
    perform td_test.act(dA);
    perform td_test.chk(td_test.q('select count(*) from public.vehicles') = '2', 'access restored');
    perform td_test.admin();
    n_pass := n_pass + 1; rpt := rpt || E'\nPASS ' || tname;
  exception when others then n_fail := n_fail + 1; rpt := rpt || E'\nFAIL ' || tname || ' -> ' || sqlerrm; end;

  -- report and roll everything back ---------------------------------------
  raise exception 'TD_REPORT % of % passed%', n_pass, n_pass + n_fail, rpt;
end $test$;

-- After running: drop schema td_test cascade;  (never leave test helpers in the database)
