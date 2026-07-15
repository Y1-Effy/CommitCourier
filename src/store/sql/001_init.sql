-- commitcourier schema.
-- All statements are idempotent (IF NOT EXISTS) so migrate() can run repeatedly.

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id              uuid PRIMARY KEY,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  endpoint_id     uuid NULL,
  target_url      text NULL,
  secret_snapshot text NULL,        -- signing-key snapshot; ciphertext when a cipher is configured (createAesGcmCipher), else plaintext
  status          text NOT NULL
                  CHECK (status IN ('pending','in_flight','delivered','dead','observed','cancelled')),
  attempts        int  NOT NULL DEFAULT 0,
  available_at    timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz NULL,
  locked_by       text NULL,
  idempotency_key text NULL,
  last_error      text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz NULL,
  CHECK (endpoint_id IS NOT NULL OR target_url IS NOT NULL) -- one of them is required
);

-- v1.1 per-endpoint FIFO ordering key: a monotonic insertion sequence. Unlike created_at (= now(),
-- which is the transaction start time and therefore identical for every row enqueued in one TX), an
-- IDENTITY column increments per row even within a single transaction (a multi-row INSERT is numbered
-- in VALUES order), so it preserves true arrival order for the per-endpoint head. Added via idempotent
-- ALTER, before the index that uses it.
ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;

-- For the dispatch claim (WHERE status='pending' AND available_at <= $1 ORDER BY available_at):
-- a partial index over only pending rows stays small as delivered/dead rows accumulate, so claims
-- and their index maintenance cost track the live backlog, not the whole table.
CREATE INDEX IF NOT EXISTS ix_outbox_due ON webhook_outbox (available_at) WHERE status = 'pending';
-- For reclaim (WHERE status='in_flight' AND locked_at < $1): partial index over the small in_flight
-- set so the visibility-timeout sweep is an index range scan, not a full-table scan.
CREATE INDEX IF NOT EXISTS ix_outbox_inflight ON webhook_outbox (locked_at) WHERE status = 'in_flight';
CREATE INDEX IF NOT EXISTS ix_outbox_endpoint ON webhook_outbox (endpoint_id);
-- v1.1 per-endpoint FIFO claim (opt-in): the DISTINCT ON (endpoint_id) head scan reads each endpoint's
-- earliest-inserted (smallest seq) non-terminal row, so index the live (pending/in_flight) set keyed by
-- (endpoint_id, seq). The head must follow arrival order (seq) -- created_at ties within a transaction
-- and the retry-mutated available_at does not reflect arrival, so neither can order the head.
CREATE INDEX IF NOT EXISTS ix_outbox_ep_head ON webhook_outbox (endpoint_id, seq)
  WHERE status IN ('pending', 'in_flight');
-- For ledger scans: cheap time-ordered scan
CREATE INDEX IF NOT EXISTS brin_outbox_created ON webhook_outbox USING brin (created_at);

CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  id                    uuid PRIMARY KEY,
  outbox_id             uuid NOT NULL REFERENCES webhook_outbox(id) ON DELETE CASCADE,
  attempt_no            int  NOT NULL,
  request_headers       jsonb NOT NULL,   -- includes signature headers; never stores the secret itself. Per-endpoint custom-header values are redacted here (names kept) -- they may carry credentials
  response_status       int  NULL,
  response_body_snippet text NULL,        -- first N KB (default 4KB)
  duration_ms           int  NOT NULL,
  error                 text NULL,
  attempted_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_attempts_outbox ON webhook_delivery_attempts (outbox_id, attempt_no);

CREATE TABLE IF NOT EXISTS webhook_endpoints (   -- optional (only for the registered-endpoint workflow)
  id            uuid PRIMARY KEY,
  url           text NOT NULL,
  secret        text NOT NULL,             -- ciphertext when a cipher is configured (createAesGcmCipher); otherwise plaintext and at-rest encryption is the DB's responsibility
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled')),
  description   text NULL,
  consecutive_failures int NOT NULL DEFAULT 0, -- auto-disable counter (only for the registered-endpoint workflow)
  disabled_at   timestamptz NULL,
  metadata      jsonb NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- v1.1 key rotation: secondary signing secret for dual-signing during a rotation window (ciphertext
-- when a cipher is configured, like `secret`). Added via idempotent ALTER so re-running migrate() on
-- an existing deployment picks it up without a separate migration file.
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS secret_secondary text NULL;
