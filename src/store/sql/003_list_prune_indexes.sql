-- 003: indexes for the read-only admin list (listOutbox) and the retention prune. Both operate on
-- terminal (finished) rows, so the indexes are PARTIAL on the prunable/terminal status set. Keeping the
-- predicate off 'pending'/'in_flight' means the fail-closed enqueue INSERT path (which writes 'pending'
-- rows) does not maintain these indexes at all -- an entry is only added when a row reaches a terminal
-- status via the completeAttempt/cancel UPDATE. This buys the admin-query speedup without taxing the hot
-- write path. The status set below mirrors PRUNABLE_STATUSES in src/store/sql/constants.ts.
--
-- Idempotent (CREATE INDEX IF NOT EXISTS) so migrate() can re-run. Plain (non-CONCURRENT) because each
-- migration runs inside a transaction, where CREATE INDEX CONCURRENTLY is disallowed. On a large existing
-- table an operator may pre-build the same-named, same-definition index with CREATE INDEX CONCURRENTLY
-- (outside migrate()); this statement then finds it already present and no-ops.

-- listOutbox filters by status (primarily the DLQ, status='dead') and pages newest-first on the seq
-- keyset (ORDER BY seq DESC, seq < cursor). seq has no index of its own (GENERATED ALWAYS AS IDENTITY
-- does not create one; the PK is on id), so without this the list is a full scan + top-N sort. The
-- (status, seq) btree serves the status equality plus the seq-ordered keyset (scanned backward for DESC).
CREATE INDEX IF NOT EXISTS ix_outbox_terminal_seq ON webhook_outbox (status, seq)
  WHERE status IN ('delivered', 'dead', 'cancelled', 'observed');

-- prune deletes the oldest terminal rows: WHERE status IN (...) AND created_at < $ ORDER BY created_at
-- LIMIT $. created_at is only covered by a BRIN index, which cannot produce sorted output, so each run
-- sorts the whole matching set. A btree on created_at (partial on the terminal set) turns the inner
-- oldest-first LIMIT select into an ordered index scan with no sort.
CREATE INDEX IF NOT EXISTS ix_outbox_prune ON webhook_outbox (created_at)
  WHERE status IN ('delivered', 'dead', 'cancelled', 'observed');
