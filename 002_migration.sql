-- ============================================================================
-- Migration 002 — Run in Supabase SQL Editor after 001_schema.sql
-- Makes contract_type nullable (only Type + Validity are optional on the
-- QR label; everything else is required).
-- ============================================================================

alter table machines alter column contract_type drop not null;

-- Light search support for the label generator's "recall past QR" feature.
-- pg_trgm gives fast ILIKE '%term%' search on free-tier Supabase without
-- needing a separate search service.
create extension if not exists pg_trgm;

create index if not exists idx_machines_customer_trgm on machines using gin (customer_name gin_trgm_ops);
create index if not exists idx_machines_serial_trgm on machines using gin (serial_number gin_trgm_ops);
create index if not exists idx_machines_brand_trgm on machines using gin (brand gin_trgm_ops);
create index if not exists idx_machines_model_trgm on machines using gin (machine_model gin_trgm_ops);
