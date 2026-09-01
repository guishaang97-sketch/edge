-- ============================================================================
-- Migration 005 — Run after 004_closed_index.sql
-- Reopening a ticket needs to clear its old resolution record so it can be
-- resolved again. There was no DELETE policy on `resolutions` at all yet
-- (RLS defaults to deny), so this was silently doing nothing.
-- ============================================================================

create policy resolutions_delete on resolutions
  for delete using (my_technician_role() in ('dispatcher','admin'));
