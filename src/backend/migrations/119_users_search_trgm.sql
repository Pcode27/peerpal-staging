-- Migration 119: trigram index on users.alias for fast ILIKE '%term%' search.
-- The existing B-tree idx_users_alias cannot use a leading wildcard; GIN+trgm can.
-- Email exact-match already benefits from the unique constraint index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_users_alias_trgm ON users USING gin(alias gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_email_trgm ON users USING gin(email gin_trgm_ops);
