-- ============================================================================
-- Migration 003 — Run in Supabase SQL Editor after 001 and 002.
-- Adds: viewer role, per-technician default region, multi-person ticket
-- assignment (team members alongside the primary assignee), resolution
-- type (the old A/E/I/J outcomes, now asked explicitly at resolve time),
-- and last-activity tracking so the board can show it without a join.
-- ============================================================================

-- --- 1. Viewer role ----------------------------------------------------------
alter type technician_role_enum add value if not exists 'viewer';

-- --- 2. Per-technician default region (board filter default) ---------------
alter table technicians add column if not exists default_region region_enum;

-- Set an employee's default region like this (run per person, once):
--   update technicians set default_region = 'NCR' where email = 'someone@example.com';

-- --- 3. Last-activity tracking on tickets (avoids an events join on the board) ---
alter table tickets add column if not exists last_activity_at timestamptz not null default now();
alter table tickets add column if not exists last_activity_label text not null default 'Ticket created';

create or replace function touch_ticket_activity()
returns trigger language plpgsql as $$
begin
  new.last_activity_at := now();
  return new;
end;
$$;

-- Keep this simple: any UPDATE to a ticket bumps last_activity_at automatically.
-- The app sets last_activity_label explicitly alongside whatever field changed
-- (see dashboard code) so the label stays human-readable instead of generic.
drop trigger if exists trg_touch_ticket_activity on tickets;
create trigger trg_touch_ticket_activity
before update on tickets
for each row execute function touch_ticket_activity();

-- --- 4. Team assignment (primary assignee stays on tickets.assigned_to;
--        this table holds additional people helping on a hard repair) -------
create table if not exists ticket_assignees (
  ticket_id uuid not null references tickets(id) on delete cascade,
  technician_id uuid not null references technicians(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (ticket_id, technician_id)
);

alter table ticket_assignees enable row level security;

create policy ticket_assignees_select on ticket_assignees
  for select using (auth.role() = 'authenticated');

create policy ticket_assignees_insert on ticket_assignees
  for insert with check (
    my_technician_role() in ('dispatcher','admin')
    or exists (select 1 from tickets t where t.id = ticket_id and t.assigned_to = auth.uid())
    or technician_id = auth.uid()  -- joining a ticket yourself as a team member
  );

create policy ticket_assignees_delete on ticket_assignees
  for delete using (
    my_technician_role() in ('dispatcher','admin')
    or exists (select 1 from tickets t where t.id = ticket_id and t.assigned_to = auth.uid())
    or technician_id = auth.uid()  -- leaving a ticket yourself
  );

-- --- 5. Resolution type (the old A/E/I/J terminal outcomes, now asked
--        explicitly on the resolve form instead of inferred) ----------------
create type resolution_type_enum as enum (
  'fixed_via_call',
  'visited_and_repaired',
  'replacement_sent',
  'closed_other'
);

alter table resolutions add column if not exists resolution_type resolution_type_enum;

-- --- 6. Lock viewers out of write actions at the DB level, not just UI ------
-- (defense in depth — the dashboard already hides these controls for
-- viewers, this makes sure a viewer can't just call the API directly)

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
  if my_technician_role() = 'viewer' then
    raise exception 'Viewers cannot claim tickets.';
  end if;

  update tickets
  set status = 'claimed',
      assigned_to = v_me,
      claimed_at = now(),
      last_activity_label = 'Claimed'
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

drop policy if exists ticket_events_insert on ticket_events;
create policy ticket_events_insert on ticket_events
  for insert with check (actor = auth.uid() and my_technician_role() != 'viewer');

drop policy if exists attachments_insert on attachments;
create policy attachments_insert on attachments
  for insert with check (uploaded_by = auth.uid() and my_technician_role() != 'viewer');

drop policy if exists resolutions_write on resolutions;
create policy resolutions_write on resolutions
  for insert with check (
    my_technician_role() != 'viewer'
    and exists (
      select 1 from tickets t
      where t.id = ticket_id
        and (t.assigned_to = auth.uid() or my_technician_role() in ('dispatcher','admin'))
    )
  );
