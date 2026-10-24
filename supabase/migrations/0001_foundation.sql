-- TruckDocs Phase 1 foundation
-- Multi-company data, accounts, documents with permanent version history, truck/trailer papers.
-- Security is enforced here (grants + Row Level Security + triggers), never only in the app.

-------------------------------------------------------------------------------
-- 0. Types
-------------------------------------------------------------------------------
create type public.member_role   as enum ('owner', 'driver');
create type public.vehicle_kind  as enum ('truck', 'trailer');
create type public.doc_type      as enum ('fuel', 'load', 'expense', 'invoice');
create type public.verify_status as enum ('pending', 'verified');

-------------------------------------------------------------------------------
-- 1. Tables
-------------------------------------------------------------------------------
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 2 and 120),
  country     text not null default 'CA' check (country in ('CA', 'US', 'AU')),
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now()
);

create table public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null check (length(btrim(full_name)) between 1 and 80),
  language    text not null default 'en' check (language in ('en', 'en-pa', 'en-hi', 'en-fr')),
  created_at  timestamptz not null default now()
);

create table public.memberships (
  company_id     uuid not null references public.companies(id),
  user_id        uuid not null references auth.users(id),
  role           public.member_role not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  deactivated_at timestamptz,
  primary key (company_id, user_id)
);
create index on public.memberships (user_id) where active;

create table public.invites (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  code        text not null unique,
  role        public.member_role not null default 'driver',
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  used_by     uuid references auth.users(id),
  used_at     timestamptz
);

create table public.vehicles (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  kind        public.vehicle_kind not null,
  unit_number text not null check (length(btrim(unit_number)) between 1 and 20),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (company_id, kind, unit_number)
);

create table public.document_requests (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id),
  driver_id             uuid not null references auth.users(id),
  doc_type              public.doc_type not null,
  note                  text check (length(note) <= 300),
  created_by            uuid not null default auth.uid() references auth.users(id),
  created_at            timestamptz not null default now(),
  fulfilled_document_id uuid,
  fulfilled_at          timestamptz
);

create table public.documents (
  id              uuid primary key default gen_random_uuid(),   -- client may supply its own id (retry-safe)
  company_id      uuid not null references public.companies(id),
  type            public.doc_type not null,
  truck_id        uuid references public.vehicles(id),
  trailer_id      uuid references public.vehicles(id),
  request_id      uuid references public.document_requests(id),
  details         jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now(),
  current_version integer not null default 0,                   -- 0 = record made, file not yet confirmed
  verification    public.verify_status,                         -- invoices only
  verified_by     uuid references auth.users(id),
  verified_at     timestamptz,
  trashed_at      timestamptz,
  trashed_by      uuid references auth.users(id)
);
create index on public.documents (company_id, created_at desc);
create index on public.documents (created_by);
create index on public.documents (truck_id);

create table public.document_versions (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.documents(id),
  company_id   uuid not null references public.companies(id),
  version_no   integer not null,
  storage_path text not null unique,
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes   integer check (size_bytes > 0),
  mime_type    text,
  uploaded_by  uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  unique (document_id, version_no)
);
create index on public.document_versions (company_id, sha256);

create table public.papers (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  vehicle_id  uuid not null references public.vehicles(id),
  paper_type  text not null check (paper_type in ('registration', 'insurance', 'inspection', 'permit', 'ifta', 'other')),
  custom_name text check (length(custom_name) <= 60),
  created_by  uuid not null default auth.uid() references auth.users(id),
  created_at  timestamptz not null default now(),
  check (paper_type <> 'other' or custom_name is not null)
);
create unique index papers_one_per_kind on public.papers (vehicle_id, paper_type, coalesce(custom_name, ''));

create table public.paper_versions (
  id           uuid primary key default gen_random_uuid(),
  paper_id     uuid not null references public.papers(id),
  company_id   uuid not null references public.companies(id),
  storage_path text not null unique,
  valid_from   date not null default current_date,
  expires_on   date not null,
  uploaded_by  uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  check (expires_on >= valid_from)
);

create table public.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id),
  company_id  uuid references public.companies(id),
  kind        text not null check (kind in ('problem', 'suggestion', 'question')),
  message     text not null check (length(btrim(message)) between 1 and 2000),
  details     jsonb not null default '{}'::jsonb,
  screen      text,
  created_at  timestamptz not null default now()
);

create table public.audit_log (
  id         bigserial primary key,
  company_id uuid,
  actor      uuid,
  action     text not null,
  entity     text not null,
  entity_id  uuid,
  details    jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);
create index on public.audit_log (company_id, at desc);

-- Receipt-reading cache (used from Phase 3). Readable only by the server.
create table public.ocr_cache (
  sha256     text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  engine     text not null,
  fields     jsonb not null,
  created_at timestamptz not null default now()
);

-------------------------------------------------------------------------------
-- 2. Private helper functions (not exposed through the API)
-------------------------------------------------------------------------------
create schema if not exists private;

create or replace function private.is_member(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.company_id = p_company and m.user_id = auth.uid() and m.active)
$$;

create or replace function private.is_owner(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.company_id = p_company and m.user_id = auth.uid() and m.active and m.role = 'owner')
$$;

create or replace function private.owns_any_company_of(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships me
                 join public.memberships them on them.company_id = me.company_id
                 where me.user_id = auth.uid() and me.active and me.role = 'owner' and them.user_id = p_user)
$$;

create or replace function private.try_uuid(p text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin return p::uuid; exception when others then return null; end $$;

create or replace function private.audit(p_company uuid, p_action text, p_entity text, p_id uuid, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log (company_id, actor, action, entity, entity_id, details)
  values (p_company, auth.uid(), p_action, p_entity, p_id, coalesce(p_details, '{}'::jsonb))
$$;

create or replace function private.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% records are permanent and cannot be %', tg_table_name,
    case tg_op when 'DELETE' then 'deleted' else 'changed' end
    using errcode = '42501';
end $$;

-------------------------------------------------------------------------------
-- 3. Integrity triggers (run for everyone, including the app's own server calls)
-------------------------------------------------------------------------------
-- Documents: server decides who created it, its starting status and verification.
create or replace function private.documents_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then new.created_by := auth.uid(); end if;
  if new.created_by is null then raise exception 'created_by required'; end if;
  new.created_at      := now();
  new.current_version := 0;
  new.verification    := case when new.type = 'invoice' then 'pending'::public.verify_status end;
  new.verified_by     := null;  new.verified_at := null;
  new.trashed_at      := null;  new.trashed_by  := null;
  if new.truck_id is not null and not exists (select 1 from public.vehicles v
       where v.id = new.truck_id and v.company_id = new.company_id and v.kind = 'truck') then
    raise exception 'truck does not belong to this company' using errcode = '42501';
  end if;
  if new.trailer_id is not null and not exists (select 1 from public.vehicles v
       where v.id = new.trailer_id and v.company_id = new.company_id and v.kind = 'trailer') then
    raise exception 'trailer does not belong to this company' using errcode = '42501';
  end if;
  if new.request_id is not null and not exists (select 1 from public.document_requests r
       where r.id = new.request_id and r.company_id = new.company_id and r.driver_id = new.created_by) then
    raise exception 'request does not belong to this driver' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger documents_before_insert before insert on public.documents
  for each row execute function private.documents_before_insert();
create trigger documents_no_delete before delete on public.documents
  for each row execute function private.forbid_change();

-- Versions: numbered by the server, must point at a file that really exists, never editable.
create or replace function private.versions_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
  select * into d from public.documents where id = new.document_id for update;
  if not found then raise exception 'document not found'; end if;
  if d.trashed_at is not null then raise exception 'document is in trash' using errcode = '42501'; end if;
  if auth.uid() is not null then new.uploaded_by := auth.uid(); end if;
  new.company_id := d.company_id;
  new.version_no := d.current_version + 1;
  new.created_at := now();
  if new.storage_path not like d.company_id::text || '/docs/' || d.id::text || '/%' then
    raise exception 'file path does not match this document' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = new.storage_path) then
    raise exception 'file not received yet; upload the file before confirming' using errcode = 'P0002';
  end if;
  return new;
end $$;
create or replace function private.versions_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
  update public.documents set
    current_version = new.version_no,
    verification = case when type = 'invoice' then 'pending'::public.verify_status end,
    verified_by  = null,
    verified_at  = null
  where id = new.document_id
  returning * into d;
  if new.version_no = 1 and d.request_id is not null then
    update public.document_requests set fulfilled_document_id = d.id, fulfilled_at = now()
    where id = d.request_id and fulfilled_at is null;
  end if;
  perform private.audit(d.company_id, case when new.version_no = 1 then 'document.sent' else 'document.replaced' end,
                        'document', d.id, jsonb_build_object('version', new.version_no, 'sha256', new.sha256));
  return new;
end $$;
create trigger versions_before_insert before insert on public.document_versions
  for each row execute function private.versions_before_insert();
create trigger versions_after_insert after insert on public.document_versions
  for each row execute function private.versions_after_insert();
create trigger versions_permanent before update or delete on public.document_versions
  for each row execute function private.forbid_change();

-- Papers and their versions.
create or replace function private.papers_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then new.created_by := auth.uid(); end if;
  if not exists (select 1 from public.vehicles v where v.id = new.vehicle_id and v.company_id = new.company_id) then
    raise exception 'vehicle does not belong to this company' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger papers_before_insert before insert on public.papers
  for each row execute function private.papers_before_insert();
create trigger papers_no_delete before delete on public.papers
  for each row execute function private.forbid_change();

create or replace function private.paper_versions_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.papers;
begin
  select * into p from public.papers where id = new.paper_id;
  if not found then raise exception 'paper not found'; end if;
  if auth.uid() is not null then new.uploaded_by := auth.uid(); end if;
  new.company_id := p.company_id;
  new.created_at := now();
  if new.storage_path not like p.company_id::text || '/papers/' || p.id::text || '/%' then
    raise exception 'file path does not match this paper' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = new.storage_path) then
    raise exception 'file not received yet; upload the file before confirming' using errcode = 'P0002';
  end if;
  return new;
end $$;
create or replace function private.paper_versions_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.audit(new.company_id, 'paper.uploaded', 'paper', new.paper_id,
                        jsonb_build_object('expires_on', new.expires_on, 'valid_from', new.valid_from));
  return new;
end $$;
create trigger paper_versions_before_insert before insert on public.paper_versions
  for each row execute function private.paper_versions_before_insert();
create trigger paper_versions_after_insert after insert on public.paper_versions
  for each row execute function private.paper_versions_after_insert();
create trigger paper_versions_permanent before update or delete on public.paper_versions
  for each row execute function private.forbid_change();

create trigger audit_permanent before update or delete on public.audit_log
  for each row execute function private.forbid_change();

-- Companies and memberships are never hard-deleted (records must outlive people leaving).
create trigger memberships_no_delete before delete on public.memberships
  for each row execute function private.forbid_change();
create trigger companies_no_delete before delete on public.companies
  for each row execute function private.forbid_change();

-------------------------------------------------------------------------------
-- 4. Actions the app calls (each checks permission itself)
-------------------------------------------------------------------------------
create or replace function public.create_company(p_name text, p_full_name text, p_language text default 'en')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_company uuid; v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'sign in first' using errcode = '42501'; end if;
  insert into public.profiles (user_id, full_name, language) values (v_user, btrim(p_full_name), p_language)
    on conflict (user_id) do update set full_name = excluded.full_name, language = excluded.language;
  insert into public.companies (name, created_by) values (btrim(p_name), v_user) returning id into v_company;
  insert into public.memberships (company_id, user_id, role) values (v_company, v_user, 'owner');
  perform private.audit(v_company, 'company.created', 'company', v_company);
  return v_company;
end $$;

create or replace function public.create_invite(p_company uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if not private.is_owner(p_company) then raise exception 'only an owner can invite drivers' using errcode = '42501'; end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.invites (company_id, code, created_by) values (p_company, v_code, auth.uid());
  perform private.audit(p_company, 'invite.created', 'invite', null);
  return v_code;
end $$;

create or replace function public.accept_invite(p_code text, p_full_name text, p_language text default 'en')
returns uuid language plpgsql security definer set search_path = '' as $$
declare i public.invites; v_user uuid := auth.uid(); m public.memberships; v_existing boolean;
begin
  if v_user is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into i from public.invites where code = upper(btrim(p_code)) for update;
  if not found or i.used_at is not null or i.expires_at < now() then
    raise exception 'this invite code is not valid or has expired' using errcode = '42501';
  end if;
  select * into m from public.memberships where company_id = i.company_id and user_id = v_user;
  v_existing := found;
  if v_existing and not m.active then
    raise exception 'your access to this company was removed by the owner' using errcode = '42501';
  end if;
  insert into public.profiles (user_id, full_name, language) values (v_user, btrim(p_full_name), p_language)
    on conflict (user_id) do update set full_name = excluded.full_name, language = excluded.language;
  if not v_existing then
    insert into public.memberships (company_id, user_id, role) values (i.company_id, v_user, i.role);
  end if;
  update public.invites set used_by = v_user, used_at = now() where id = i.id;
  perform private.audit(i.company_id, 'member.joined', 'user', v_user);
  return i.company_id;
end $$;

create or replace function public.set_member_active(p_company uuid, p_user uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare m public.memberships;
begin
  if not private.is_owner(p_company) then raise exception 'only an owner can change access' using errcode = '42501'; end if;
  select * into m from public.memberships where company_id = p_company and user_id = p_user for update;
  if not found then raise exception 'person not found in this company'; end if;
  if not p_active and m.role = 'owner' and (select count(*) from public.memberships
       where company_id = p_company and role = 'owner' and active) <= 1 then
    raise exception 'a company must keep at least one active owner' using errcode = '42501';
  end if;
  update public.memberships set active = p_active, deactivated_at = case when p_active then null else now() end
  where company_id = p_company and user_id = p_user;
  perform private.audit(p_company, case when p_active then 'member.restored' else 'member.removed' end, 'user', p_user);
end $$;

create or replace function public.verify_invoice(p_document uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
  select * into d from public.documents where id = p_document for update;
  if not found or not private.is_owner(d.company_id) then raise exception 'only an owner can verify invoices' using errcode = '42501'; end if;
  if d.type <> 'invoice' then raise exception 'only invoices need verification' using errcode = '22023'; end if;
  if d.current_version = 0 or d.trashed_at is not null then raise exception 'nothing to verify' using errcode = '22023'; end if;
  update public.documents set verification = 'verified', verified_by = auth.uid(), verified_at = now() where id = p_document;
  perform private.audit(d.company_id, 'invoice.verified', 'document', d.id, jsonb_build_object('version', d.current_version));
end $$;

create or replace function public.trash_document(p_document uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
  select * into d from public.documents where id = p_document for update;
  if not found or not private.is_owner(d.company_id) then raise exception 'only an owner can move documents to trash' using errcode = '42501'; end if;
  update public.documents set trashed_at = now(), trashed_by = auth.uid() where id = p_document and trashed_at is null;
  perform private.audit(d.company_id, 'document.trashed', 'document', d.id);
end $$;

create or replace function public.restore_document(p_document uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
  select * into d from public.documents where id = p_document for update;
  if not found or not private.is_owner(d.company_id) then raise exception 'only an owner can restore documents' using errcode = '42501'; end if;
  update public.documents set trashed_at = null, trashed_by = null where id = p_document;
  perform private.audit(d.company_id, 'document.restored', 'document', d.id);
end $$;

create or replace function public.update_document_details(p_document uuid, p_details jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
  select * into d from public.documents where id = p_document for update;
  if not found or not (private.is_owner(d.company_id) or (private.is_member(d.company_id) and d.created_by = auth.uid())) then
    raise exception 'not allowed to change this document' using errcode = '42501';
  end if;
  if d.trashed_at is not null then raise exception 'document is in trash' using errcode = '42501'; end if;
  if jsonb_typeof(p_details) <> 'object' then raise exception 'details must be an object' using errcode = '22023'; end if;
  update public.documents set details = p_details where id = p_document;
  perform private.audit(d.company_id, 'document.details_changed', 'document', d.id,
                        jsonb_build_object('before', d.details, 'after', p_details));
end $$;

-------------------------------------------------------------------------------
-- 5. Privileges: start from nothing, then grant only what is needed
-------------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
revoke all on all functions in schema private from anon, authenticated, public;

grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid), private.is_owner(uuid),
                          private.owns_any_company_of(uuid), private.try_uuid(text) to authenticated;

grant execute on function public.create_company(text, text, text), public.create_invite(uuid),
  public.accept_invite(text, text, text), public.set_member_active(uuid, uuid, boolean),
  public.verify_invoice(uuid), public.trash_document(uuid), public.restore_document(uuid),
  public.update_document_details(uuid, jsonb) to authenticated;

grant select on public.companies, public.memberships, public.invites, public.vehicles,
                public.documents, public.document_versions, public.papers, public.paper_versions,
                public.document_requests, public.feedback, public.audit_log to authenticated;
grant select, insert on public.profiles to authenticated;
grant update (full_name, language) on public.profiles to authenticated;
grant update (name) on public.companies to authenticated;
grant insert (company_id, kind, unit_number) on public.vehicles to authenticated;
grant update (unit_number, active) on public.vehicles to authenticated;
grant insert (id, company_id, type, truck_id, trailer_id, request_id, details) on public.documents to authenticated;
grant insert (id, document_id, storage_path, sha256, size_bytes, mime_type) on public.document_versions to authenticated;
grant insert (company_id, vehicle_id, paper_type, custom_name) on public.papers to authenticated;
grant insert (paper_id, storage_path, valid_from, expires_on) on public.paper_versions to authenticated;
grant insert (company_id, driver_id, doc_type, note) on public.document_requests to authenticated;
grant insert (company_id, kind, message, details, screen) on public.feedback to authenticated;
-- Deliberately NO delete grant anywhere, and no update on documents/versions/papers/audit_log.

-------------------------------------------------------------------------------
-- 6. Row Level Security
-------------------------------------------------------------------------------
alter table public.companies          enable row level security;
alter table public.profiles           enable row level security;
alter table public.memberships        enable row level security;
alter table public.invites            enable row level security;
alter table public.vehicles           enable row level security;
alter table public.documents          enable row level security;
alter table public.document_versions  enable row level security;
alter table public.papers             enable row level security;
alter table public.paper_versions     enable row level security;
alter table public.document_requests  enable row level security;
alter table public.feedback           enable row level security;
alter table public.audit_log          enable row level security;
alter table public.ocr_cache          enable row level security;   -- no policies: server only

create policy companies_read   on public.companies for select to authenticated using (private.is_member(id));
create policy companies_rename on public.companies for update to authenticated using (private.is_owner(id)) with check (private.is_owner(id));

create policy profiles_read   on public.profiles for select to authenticated
  using (user_id = auth.uid() or private.owns_any_company_of(user_id));
create policy profiles_insert on public.profiles for insert to authenticated with check (user_id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy memberships_read on public.memberships for select to authenticated
  using (user_id = auth.uid() or private.is_owner(company_id));

create policy invites_read on public.invites for select to authenticated using (private.is_owner(company_id));

create policy vehicles_read   on public.vehicles for select to authenticated using (private.is_member(company_id));
create policy vehicles_insert on public.vehicles for insert to authenticated with check (private.is_owner(company_id));
create policy vehicles_update on public.vehicles for update to authenticated
  using (private.is_owner(company_id)) with check (private.is_owner(company_id));

-- Owners see all company documents; drivers see the ones they sent.
create policy documents_read on public.documents for select to authenticated
  using (private.is_owner(company_id) or (private.is_member(company_id) and created_by = auth.uid()));
create policy documents_insert on public.documents for insert to authenticated
  with check (private.is_member(company_id));

create policy versions_read on public.document_versions for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id));        -- inherits documents_read
create policy versions_insert on public.document_versions for insert to authenticated
  with check (exists (select 1 from public.documents d where d.id = document_id
                      and (private.is_owner(d.company_id) or (private.is_member(d.company_id) and d.created_by = auth.uid()))));

create policy papers_read   on public.papers for select to authenticated using (private.is_member(company_id));
create policy papers_insert on public.papers for insert to authenticated with check (private.is_owner(company_id));
create policy paper_versions_read on public.paper_versions for select to authenticated
  using (private.is_owner(company_id) or (private.is_member(company_id) and expires_on >= current_date));
create policy paper_versions_insert on public.paper_versions for insert to authenticated
  with check (exists (select 1 from public.papers p where p.id = paper_id and private.is_owner(p.company_id)));

create policy requests_read on public.document_requests for select to authenticated
  using (private.is_owner(company_id) or (private.is_member(company_id) and driver_id = auth.uid()));
create policy requests_insert on public.document_requests for insert to authenticated
  with check (private.is_owner(company_id)
              and exists (select 1 from public.memberships m where m.company_id = document_requests.company_id
                          and m.user_id = document_requests.driver_id and m.active));

create policy feedback_read   on public.feedback for select to authenticated using (user_id = auth.uid());
create policy feedback_insert on public.feedback for insert to authenticated
  with check (user_id = auth.uid() and (company_id is null or private.is_member(company_id)));

create policy audit_read on public.audit_log for select to authenticated using (private.is_owner(company_id));

-------------------------------------------------------------------------------
-- 7. File storage: one private bucket, folders by company. No overwrite, no delete.
--    Paths:  <company_id>/docs/<document_id>/<file>   and   <company_id>/papers/<paper_id>/<file>
-------------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('documents', 'documents', false)
  on conflict (id) do update set public = false;

create policy td_files_upload on storage.objects for insert to authenticated
with check (
  bucket_id = 'documents'
  and array_length(storage.foldername(name), 1) = 3
  and private.is_member(private.try_uuid((storage.foldername(name))[1]))
  and (
    ((storage.foldername(name))[2] = 'docs' and exists (
        select 1 from public.documents d
        where d.id = private.try_uuid((storage.foldername(name))[3])
          and d.company_id = private.try_uuid((storage.foldername(name))[1])
          and d.trashed_at is null))                                   -- documents_read applies: drivers only their own
    or
    ((storage.foldername(name))[2] = 'papers' and private.is_owner(private.try_uuid((storage.foldername(name))[1]))
        and exists (select 1 from public.papers p
                    where p.id = private.try_uuid((storage.foldername(name))[3])
                      and p.company_id = private.try_uuid((storage.foldername(name))[1])))
  )
);

-- A file can be opened only if the person can see the record that points to it.
create policy td_files_read on storage.objects for select to authenticated
using (
  bucket_id = 'documents' and (
    exists (select 1 from public.document_versions v where v.storage_path = name)
    or exists (select 1 from public.paper_versions pv where pv.storage_path = name)
  )
);
-- Deliberately no UPDATE (overwrite) and no DELETE policy for app users.
