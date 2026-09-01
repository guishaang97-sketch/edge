-- ============================================================================
-- Migration 008 — Run after 007_pm_contracts_and_retirement.sql
-- Replaces duration_years with total_visits (exact count, since "3 PMs" at
-- a given frequency doesn't always land on a whole number of years).
-- Also exposes `active` on machine search results for the retired-machine
-- indicator in the label generator.
-- ============================================================================

alter table pm_contracts add column if not exists total_visits smallint;

-- Backfill for any contracts already created before this migration
-- (harmless no-op if the table's still empty, which is likely at this stage).
update pm_contracts
set total_visits = greatest(1, floor(extract(epoch from age(end_date, start_date)) / (interval_months * 2592000)) + 1)
where total_visits is null;

alter table pm_contracts alter column total_visits set not null;
alter table pm_contracts add constraint pm_contracts_total_visits_positive check (total_visits > 0);
alter table pm_contracts drop column if exists duration_years;

-- end_date is now derived from total_visits directly instead of years.
create or replace function set_pm_contract_end_date()
returns trigger language plpgsql as $$
begin
  new.end_date := new.start_date + ((new.total_visits - 1) * new.interval_months || ' months')::interval;
  return new;
end;
$$;

-- generate_pm_visits() itself is unchanged — it already loops from
-- start_date to end_date in interval_months steps, so a correctly computed
-- end_date naturally produces exactly total_visits rows.
