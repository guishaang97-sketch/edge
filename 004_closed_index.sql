-- ============================================================================
-- Migration 004 — Run after 003_dashboard_v2.sql
-- Speeds up the Closed tab's date-range filter. Uses last_activity_at
-- rather than closed_at because a resolved-but-not-yet-closed ticket has
-- no closed_at yet but still needs to show up in that tab.
-- ============================================================================

create index if not exists idx_tickets_closed_activity on tickets(last_activity_at)
  where status in ('resolved', 'closed');
