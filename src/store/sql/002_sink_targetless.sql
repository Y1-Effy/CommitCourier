-- 002: allow target-less rows for the sink transport (08-forward-sink).
-- The original table CHECK required a per-event target (endpoint_id or target_url). The `sink`
-- transport has neither -- the destination is the configured sink/SaaS -- so a sink row is target-less.
-- Drop the constraint; the application layer (buildRow) still requires a target for `http` mode.
-- Idempotent: DROP CONSTRAINT IF EXISTS is a no-op once removed (or on a fresh schema built without it).
-- webhook_outbox_check is the Postgres default name for the single table-level CHECK in 001_init
-- (the status CHECK is a column constraint named webhook_outbox_status_check, so it is unaffected).
ALTER TABLE webhook_outbox DROP CONSTRAINT IF EXISTS webhook_outbox_check;
