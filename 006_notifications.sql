-- ============================================================================
-- Migration 006 — Run after 005_resolution_delete.sql
-- Adds what the notification system needs: per-region Telegram group chat
-- IDs, and two dedupe timestamps so the hourly scheduled job doesn't send
-- the same escalation alert or closure email twice.
-- ============================================================================

alter table tickets add column if not exists escalation_notified_at timestamptz;
alter table tickets add column if not exists closure_email_sent_at timestamptz;

-- One Telegram group chat per region. Set these up yourself (see
-- notify/README.md for the BotFather + "get chat ID" steps), then insert
-- rows here, e.g.:
--   insert into region_telegram_channels (region, chat_id) values ('NCR', '-1001234567890');
create table if not exists region_telegram_channels (
  region region_enum primary key,
  chat_id text not null,
  created_at timestamptz not null default now()
);

alter table region_telegram_channels enable row level security;

create policy region_telegram_channels_select on region_telegram_channels
  for select using (my_technician_role() in ('dispatcher','admin'));

create policy region_telegram_channels_write on region_telegram_channels
  for all using (my_technician_role() = 'admin') with check (my_technician_role() = 'admin');

-- Index to make the hourly escalation/closure scan cheap.
create index if not exists idx_tickets_escalation_check on tickets(escalation_deadline)
  where status = 'unclaimed' and escalation_notified_at is null;

create index if not exists idx_tickets_closure_check on tickets(closed_at)
  where status = 'closed' and closure_email_sent_at is null;
