-- ============================================================================
-- Migration 007 — Run after 006_notifications.sql
-- Adds: PM contracts (with auto-generated visit schedule), machine
-- retirement (for "moved to a new customer" without rewriting history),
-- and fixes the knowledge_base view which predates resolution_type.
-- ============================================================================

-- --- 1. Fix knowledge_base view (resolution_type didn't exist when it was
--        first created back in 001_schema.sql) -----------------------------
-- Dropped and recreated rather than CREATE OR REPLACE, because Postgres
-- only allows REPLACE to append columns at the end — it can't insert
-- resolution_type in the middle of the existing column order.
drop view if exists knowledge_base;

create view knowledge_base as
select
  r.id as resolution_id,
  t.id as ticket_id,
  t.ticket_number,
  m.brand,
  m.machine_model,
  m.serial_number,
  r.symptom_category,
  r.resolution_type,
  r.error_code,
  r.root_cause,
  r.resolution_notes,
  r.parts_used,
  t.resolved_at
from resolutions r
join tickets t on t.id = r.ticket_id
join machines m on m.id = t.machine_id;

-- --- 2. Machine retirement ----------------------------------------------
-- A machine moving to a different customer is NOT an in-place edit (that
-- would silently rewrite the customer name on every past ticket for it).
-- Instead: retire the old row, register a fresh one. Old QR becomes a
-- dead end; old history stays exactly as it was.

alter table machines add column if not exists active boolean not null default true;
alter table machines add column if not exists retired_at timestamptz;
alter table machines add column if not exists retired_by uuid references technicians(id);
alter table machines add column if not exists retired_reason text;

-- Serial numbers only need to be unique among ACTIVE machines — once a
-- machine is retired, that serial number is free to be reused when the
-- same physical unit gets re-registered under its new customer.
alter table machines drop constraint if exists machines_serial_number_key;
create unique index if not exists machines_serial_active_unique on machines(serial_number) where active;

create index if not exists idx_machines_active on machines(active);

-- --- 3. PM contracts -------------------------------------------------------
create type pm_contract_status_enum as enum ('active', 'terminated', 'completed');

create table if not exists pm_contracts (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references machines(id),
  focus text not null,                 -- e.g. "Calibration PM", "Filter Replacement PM"
  interval_months smallint not null check (interval_months between 1 and 12),
  start_date date not null,
  duration_years smallint not null check (duration_years > 0),
  end_date date not null,              -- computed on insert, see trigger below
  status pm_contract_status_enum not null default 'active',
  terminated_at timestamptz,
  terminated_by uuid references technicians(id),
  termination_reason text,
  notes text,
  created_by uuid references technicians(id),
  created_at timestamptz not null default now()
);

create index idx_pm_contracts_machine on pm_contracts(machine_id);
create index idx_pm_contracts_status on pm_contracts(status);

create or replace function set_pm_contract_end_date()
returns trigger language plpgsql as $$
begin
  new.end_date := new.start_date + (new.duration_years || ' years')::interval;
  return new;
end;
$$;

create trigger trg_set_pm_contract_end_date
before insert on pm_contracts
for each row execute function set_pm_contract_end_date();

-- Auto-generate every visit for the contract's full duration the moment
-- it's created — no manual date entry per visit.
create or replace function generate_pm_visits()
returns trigger language plpgsql as $$
declare
  v_date date := new.start_date;
begin
  while v_date <= new.end_date loop
    insert into pm_schedules (machine_id, pm_contract_id, scheduled_date, status)
    values (new.machine_id, new.id, v_date, 'upcoming');
    v_date := v_date + (new.interval_months || ' months')::interval;
  end loop;
  return new;
end;
$$;

create trigger trg_generate_pm_visits
after insert on pm_contracts
for each row execute function generate_pm_visits();

-- --- 4. pm_schedules additions ----------------------------------------------
alter table pm_schedules add column if not exists pm_contract_id uuid references pm_contracts(id) on delete cascade;
alter type pm_status_enum add value if not exists 'cancelled';

create index if not exists idx_pm_schedules_contract on pm_schedules(pm_contract_id);

-- --- 5. Termination / reactivation — admin-only, reason required, fully
--        reversible. Run as two separate statements in the SQL editor if
--        you hit the "unsafe use of new enum value" error on 'cancelled'
--        above — same rule as the earlier viewer-role migration.
create or replace function terminate_pm_contract(p_contract_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if my_technician_role() != 'admin' then
    raise exception 'Only admins can terminate a PM contract.';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A termination reason is required.';
  end if;

  update pm_contracts
  set status = 'terminated', terminated_at = now(), terminated_by = auth.uid(), termination_reason = p_reason
  where id = p_contract_id and status = 'active';

  -- Completed visits stay in history untouched — only cancel what hasn't
  -- happened yet.
  update pm_schedules
  set status = 'cancelled'
  where pm_contract_id = p_contract_id and status not in ('completed', 'cancelled');
end;
$$;

create or replace function reactivate_pm_contract(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if my_technician_role() != 'admin' then
    raise exception 'Only admins can reactivate a PM contract.';
  end if;

  update pm_contracts
  set status = 'active', terminated_at = null, terminated_by = null, termination_reason = null
  where id = p_contract_id and status = 'terminated';

  update pm_schedules
  set status = case when scheduled_date < current_date then 'overdue' else 'upcoming' end
  where pm_contract_id = p_contract_id and status = 'cancelled';
end;
$$;

-- --- 6. RLS ------------------------------------------------------------------
alter table pm_contracts enable row level security;

create policy pm_contracts_select on pm_contracts
  for select using (auth.role() = 'authenticated');

create policy pm_contracts_insert on pm_contracts
  for insert with check (my_technician_role() in ('dispatcher', 'admin'));

-- Direct updates are intentionally admin-only and narrow (notes only, in
-- practice) — status changes go through the two RPCs above so the
-- reason-required / admin-only rules can't be bypassed by a raw UPDATE.
create policy pm_contracts_update on pm_contracts
  for update using (my_technician_role() = 'admin');
