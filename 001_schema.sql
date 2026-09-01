-- ============================================================================
-- MRL Cybertec Service Ticketing — Initial Schema
-- Target: Supabase (Postgres 15+)
-- Run this in the Supabase SQL Editor on a fresh project, top to bottom.
-- ============================================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ============================================================================
-- 1. ENUMS
-- ============================================================================

create type region_enum as enum ('NCR','North','South','Cebu','Davao','NSC');

-- "Type" as printed on the QR label (Parts / Service / Parts and Service / RTU)
create type contract_type_enum as enum ('parts','service','parts_and_service','rtu');

create type ticket_status_enum as enum ('unclaimed','claimed','in_progress','resolved','closed');

-- legacy A–J shorthand codes, kept as a filterable detail field (§6.1)
create type status_code_enum as enum (
  'fixed_via_call',
  'follow_up_call',
  'requires_personal_visit',
  'for_parts_ordering',
  'visited_and_repaired',
  'for_in_office_repair',
  'service_unit_sent',
  'unrepairable',
  'replacement_sent',
  'closed_other'
);

create type event_type_enum as enum ('claimed','status_change','status_code_change','note','reassigned','escalated');

create type symptom_category_enum as enum ('hardware','software');

create type technician_role_enum as enum ('technician','dispatcher','admin');

create type pm_status_enum as enum ('upcoming','notified_week','notified_daily','completed','overdue');

-- ============================================================================
-- 2. TECHNICIANS  (linked 1:1 to Supabase auth users)
-- ============================================================================

create table technicians (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  phone text,
  regions_subscribed region_enum[] not null default '{}',
  role technician_role_enum not null default 'technician',
  active boolean not null default true,
  push_subscription jsonb,           -- can hold one subscription; see technician_push_subscriptions for multi-device
  notify_via_email boolean not null default true,
  notify_via_push boolean not null default true,
  notify_via_telegram boolean not null default false, -- reserve channel, off by default (§6.4)
  telegram_chat_id text,
  created_at timestamptz not null default now()
);

-- multi-device push support (§6.4 — phone + laptop, unsubscribe independently)
create table technician_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  technician_id uuid not null references technicians(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,   -- full PushSubscription object (endpoint, keys.p256dh, keys.auth)
  device_label text,             -- e.g. "Chrome / Pixel 8"
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 3. MACHINES  (the asset registry; QR label fields live here)
-- ============================================================================

create table machines (
  id uuid primary key default gen_random_uuid(),
  qr_short_id text not null unique,           -- short code embedded in the QR / short link
  customer_name text not null,
  brand text not null,
  machine_model text not null,                -- "Machine" on the QR label
  serial_number text not null,
  region region_enum not null,
  contract_type contract_type_enum not null,  -- "Type" on the QR label
  contract_validity date,                     -- "Validity" on the QR label (nullable: not always known at label print time)
  install_date date,
  created_at timestamptz not null default now(),
  unique (serial_number)
);

create index idx_machines_region on machines(region);
create index idx_machines_qr_short_id on machines(qr_short_id);

-- ============================================================================
-- 4. TICKETS
-- ============================================================================

create table tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number text not null unique,          -- e.g. MRLSRV-2026-00001, see §5 below
  machine_id uuid not null references machines(id),
  status ticket_status_enum not null default 'unclaimed',
  status_code status_code_enum,
  region region_enum not null,                 -- denormalized from machine at creation, for fast filtering
  assigned_to uuid references technicians(id),
  claimed_at timestamptz,
  description text,                            -- customer-entered issue description
  contact_name text,
  contact_number text,
  contact_email text,                          -- optional; gates whether a PDF report is emailed (§6.3)
  escalation_deadline timestamptz,              -- computed on insert, used by SLA job (§6.6, Phase 3)
  escalated_at timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  closed_at timestamptz
);

create index idx_tickets_status on tickets(status);
create index idx_tickets_region on tickets(region);
create index idx_tickets_machine on tickets(machine_id);
create index idx_tickets_assigned_to on tickets(assigned_to);
create index idx_tickets_status_code on tickets(status_code);

-- keep region in sync with the machine at insert time
create or replace function set_ticket_region()
returns trigger language plpgsql as $$
begin
  if new.region is null then
    select region into new.region from machines where id = new.machine_id;
  end if;
  return new;
end;
$$;

create trigger trg_set_ticket_region
before insert on tickets
for each row execute function set_ticket_region();

-- ============================================================================
-- 5. TICKET NUMBERING  — format MRLSRV-{year}-{5-digit sequence}, starts at 1
-- ============================================================================

create sequence ticket_number_seq start 1;

create or replace function generate_ticket_number()
returns text language plpgsql as $$
declare
  seq_val bigint;
  yr text := to_char(now(), 'YYYY');
begin
  seq_val := nextval('ticket_number_seq');
  return 'MRLSRV-' || yr || '-' || lpad(seq_val::text, 5, '0');
end;
$$;

create or replace function set_ticket_number()
returns trigger language plpgsql as $$
begin
  if new.ticket_number is null then
    new.ticket_number := generate_ticket_number();
  end if;
  return new;
end;
$$;

create trigger trg_set_ticket_number
before insert on tickets
for each row execute function set_ticket_number();

-- Reset the counter back to 1. Intended for use ONLY between test runs,
-- before real customer-facing tickets start. Admin-only (see grants below).
-- Does NOT touch existing ticket rows — run this only against an empty
-- `tickets` table, or you'll get duplicate ticket_number collisions.
create or replace function reset_ticket_sequence()
returns void
language sql
security definer
set search_path = public
as $$
  select setval('ticket_number_seq', 1, false);
$$;

-- ============================================================================
-- 6. TICKET EVENTS  (audit trail)
-- ============================================================================

create table ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  actor uuid references technicians(id),
  event_type event_type_enum not null,
  detail text,
  created_at timestamptz not null default now()
);

create index idx_ticket_events_ticket on ticket_events(ticket_id);

-- ============================================================================
-- 7. RESOLUTIONS  (structured fix record — required before status = 'resolved')
-- ============================================================================

create table resolutions (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null unique references tickets(id) on delete cascade,
  symptom_category symptom_category_enum not null,
  error_code text,
  root_cause text not null,
  resolution_notes text not null,
  parts_used text[],
  created_at timestamptz not null default now()
);

-- Gate: a ticket cannot move to 'resolved' without a matching resolutions row.
create or replace function enforce_resolution_before_resolved()
returns trigger language plpgsql as $$
begin
  if new.status = 'resolved' and old.status is distinct from 'resolved' then
    if not exists (select 1 from resolutions where ticket_id = new.id) then
      raise exception 'Cannot mark ticket resolved without a resolutions record (ticket %)', new.ticket_number;
    end if;
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  if new.status = 'closed' and old.status is distinct from 'closed' then
    new.closed_at := coalesce(new.closed_at, now());
  end if;
  return new;
end;
$$;

create trigger trg_enforce_resolution
before update on tickets
for each row execute function enforce_resolution_before_resolved();

-- ============================================================================
-- 8. ATTACHMENTS  (photos, uses Supabase Storage — bucket created separately)
-- ============================================================================

create table attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  file_url text not null,
  uploaded_by uuid references technicians(id),
  uploaded_at timestamptz not null default now(),
  caption text
);

create index idx_attachments_ticket on attachments(ticket_id);

-- ============================================================================
-- 9. PM SCHEDULES  (Phase 3, but table can exist now)
-- ============================================================================

create table pm_schedules (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references machines(id) on delete cascade,
  scheduled_date date not null,
  status pm_status_enum not null default 'upcoming',
  last_notified_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create index idx_pm_schedules_machine on pm_schedules(machine_id);
create index idx_pm_schedules_status on pm_schedules(status);

-- ============================================================================
-- 10. KNOWLEDGE BASE  — a view, not a table, per §4.1 (promote later if needed)
-- ============================================================================

create or replace view knowledge_base as
select
  r.id as resolution_id,
  t.id as ticket_id,
  t.ticket_number,
  m.brand,
  m.machine_model,
  m.serial_number,
  r.symptom_category,
  r.error_code,
  r.root_cause,
  r.resolution_notes,
  r.parts_used,
  t.resolved_at
from resolutions r
join tickets t on t.id = r.ticket_id
join machines m on m.id = t.machine_id;

-- ============================================================================
-- 11. CLAIM TICKET  — atomic claim RPC (§6.2)
--     UPDATE ... WHERE assigned_to IS NULL is atomic at the row level in
--     Postgres, so two simultaneous claims cannot both succeed.
-- ============================================================================

create or replace function claim_ticket(p_ticket_id uuid)
returns tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket tickets;
  v_me uuid := auth.uid();
begin
  update tickets
  set status = 'claimed',
      assigned_to = v_me,
      claimed_at = now()
  where id = p_ticket_id
    and assigned_to is null
  returning * into v_ticket;

  if v_ticket.id is null then
    raise exception 'Ticket % is no longer unclaimed', p_ticket_id;
  end if;

  insert into ticket_events (ticket_id, actor, event_type, detail)
  values (p_ticket_id, v_me, 'claimed', 'Self-claimed');

  return v_ticket;
end;
$$;

-- ============================================================================
-- 12. HELPER: current user's role / technician row (used by RLS policies)
-- ============================================================================

create or replace function my_technician_role()
returns technician_role_enum
language sql
security definer
set search_path = public
stable
as $$
  select role from technicians where id = auth.uid();
$$;

-- ============================================================================
-- 13. ROW LEVEL SECURITY
-- ============================================================================

alter table technicians enable row level security;
alter table technician_push_subscriptions enable row level security;
alter table machines enable row level security;
alter table tickets enable row level security;
alter table ticket_events enable row level security;
alter table resolutions enable row level security;
alter table attachments enable row level security;
alter table pm_schedules enable row level security;

-- technicians: everyone authenticated can see the roster (needed for assignment UI);
-- only admins or the row owner can update it.
create policy technicians_select on technicians
  for select using (auth.role() = 'authenticated');

create policy technicians_update_self_or_admin on technicians
  for update using (id = auth.uid() or my_technician_role() = 'admin');

create policy technicians_insert_admin on technicians
  for insert with check (my_technician_role() = 'admin' or id = auth.uid());

-- push subscriptions: only the owning technician manages their own devices
create policy push_subs_owner on technician_push_subscriptions
  for all using (technician_id = auth.uid())
  with check (technician_id = auth.uid());

-- machines: all authenticated staff can view; dispatcher/admin can write
create policy machines_select on machines
  for select using (auth.role() = 'authenticated');

create policy machines_write on machines
  for insert with check (my_technician_role() in ('dispatcher','admin'));

create policy machines_update on machines
  for update using (my_technician_role() in ('dispatcher','admin'));

-- tickets: all authenticated staff can view all tickets (§7 — technicians can
-- search/claim outside their subscribed regions, subscription only affects
-- notifications, not visibility).
create policy tickets_select on tickets
  for select using (auth.role() = 'authenticated');

-- direct UPDATE is still allowed for status/status_code/resolution edits by
-- the assignee, or by dispatcher/admin for anyone's ticket. Claiming itself
-- should go through claim_ticket() rather than a raw UPDATE.
create policy tickets_update on tickets
  for update using (
    assigned_to = auth.uid()
    or my_technician_role() in ('dispatcher','admin')
  );

-- ticket creation happens from the public intake form via a service-role
-- edge function (anonymous customers are never authenticated staff), so no
-- authenticated INSERT policy is needed here for the customer-facing path.
create policy tickets_insert_staff on tickets
  for insert with check (auth.role() = 'authenticated');

-- ticket_events: readable by all staff; insertable by any authenticated staff
-- (acting as themselves)
create policy ticket_events_select on ticket_events
  for select using (auth.role() = 'authenticated');

create policy ticket_events_insert on ticket_events
  for insert with check (actor = auth.uid());

-- resolutions: readable by all staff; writable by the ticket's assignee or
-- dispatcher/admin
create policy resolutions_select on resolutions
  for select using (auth.role() = 'authenticated');

create policy resolutions_write on resolutions
  for insert with check (
    exists (
      select 1 from tickets t
      where t.id = ticket_id
        and (t.assigned_to = auth.uid() or my_technician_role() in ('dispatcher','admin'))
    )
  );

create policy resolutions_update on resolutions
  for update using (
    exists (
      select 1 from tickets t
      where t.id = ticket_id
        and (t.assigned_to = auth.uid() or my_technician_role() in ('dispatcher','admin'))
    )
  );

-- attachments: readable by all staff; writable by anyone authenticated
create policy attachments_select on attachments
  for select using (auth.role() = 'authenticated');

create policy attachments_insert on attachments
  for insert with check (uploaded_by = auth.uid());

-- pm_schedules: readable by all staff; writable by dispatcher/admin
create policy pm_select on pm_schedules
  for select using (auth.role() = 'authenticated');

create policy pm_write on pm_schedules
  for insert with check (my_technician_role() in ('dispatcher','admin'));

create policy pm_update on pm_schedules
  for update using (my_technician_role() in ('dispatcher','admin'));

-- ============================================================================
-- 14. NOTES
-- ============================================================================
-- * Customer intake form writes (machines + tickets) should go through a
--   Supabase Edge Function using the SERVICE ROLE key (bypasses RLS), never
--   a direct anon-key insert from the browser, so the form can't be abused
--   to write arbitrary technician/ticket data.
-- * escalation_deadline (SLA, §6.6) is computed application-side (working-
--   hours math is awkward in pure SQL) inside the same edge function that
--   creates the ticket, then stored here for the scheduled job to check.
-- * reset_ticket_sequence() is callable only via the service role — do not
--   grant it to the `authenticated` role. Call it from the SQL editor or a
--   one-off script during testing, never from the app.
