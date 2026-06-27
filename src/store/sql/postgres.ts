/**
 * Postgres SQL dialect (per the store-generalization design).
 *
 * Holds the Postgres-specific SQL that was previously inlined in `../_shared`: the claim CTE
 * (`FOR UPDATE SKIP LOCKED` + `RETURNING`) and the `to_regclass` existence probe. The DDL is applied
 * by the migration runner in `../_shared` (it owns the embedded schema), not through this dialect.
 */
import { OUTBOX_TABLE, ATTEMPTS_TABLE, ENDPOINTS_TABLE } from "../_shared";
import type { SqlDialect } from "./dialect";

interface ClaimPlaceholders {
  now: string;
  limit: string;
  nowSet: string;
  lockedBy: string;
}

interface PerEndpointClaimPlaceholders {
  nowHead: string;
  nowInline: string;
  limit: string;
  nowSet: string;
  lockedBy: string;
}

/**
 * Claim query (02-store section 6). One CTE: `SELECT ... FOR UPDATE SKIP LOCKED`, then `UPDATE`
 * to `in_flight`, `RETURNING` the claimed rows. Rendered per placeholder style so both driver
 * adapters share identical semantics.
 */
function buildClaimSql(p: ClaimPlaceholders): string {
  return `WITH due AS (
  SELECT id FROM ${OUTBOX_TABLE}
  WHERE status = 'pending' AND available_at <= ${p.now}
  ORDER BY available_at
  FOR UPDATE SKIP LOCKED
  LIMIT ${p.limit}
)
UPDATE ${OUTBOX_TABLE} o
SET status = 'in_flight', locked_at = ${p.nowSet}, locked_by = ${p.lockedBy}
FROM due
WHERE o.id = due.id
RETURNING o.*`;
}

/**
 * Per-endpoint FIFO claim (02-store section 6.1). For each registered endpoint, the candidate is its
 * earliest-inserted (smallest `seq`) non-terminal row (`pending` or `in_flight`); it is claimable only
 * when that head row is itself `pending` and due — so an in-flight row blocks the endpoint, and a row
 * awaiting retry (future `available_at`) holds the line until it is due. The head is ordered by `seq`
 * (a monotonic insertion sequence), not `created_at` or `available_at`: `created_at` is identical for
 * every row enqueued in one transaction, and `available_at` is pushed into the future by a retry
 * backoff — either would let a later row jump ahead and break FIFO. Inline (null-endpoint) rows are
 * claimed as usual. The claimable set is then locked with `FOR UPDATE SKIP LOCKED` and moved to
 * `in_flight`.
 */
function buildPerEndpointClaimSql(p: PerEndpointClaimPlaceholders): string {
  return `WITH cand AS (
  SELECT id, available_at FROM (
    SELECT DISTINCT ON (endpoint_id) id, status, available_at
    FROM ${OUTBOX_TABLE}
    WHERE endpoint_id IS NOT NULL AND status IN ('pending', 'in_flight')
    ORDER BY endpoint_id, seq
  ) head
  WHERE head.status = 'pending' AND head.available_at <= ${p.nowHead}
  UNION ALL
  SELECT id, available_at FROM ${OUTBOX_TABLE}
  WHERE endpoint_id IS NULL AND status = 'pending' AND available_at <= ${p.nowInline}
),
locked AS (
  SELECT o.id FROM ${OUTBOX_TABLE} o
  JOIN cand ON cand.id = o.id
  WHERE o.status = 'pending'
  ORDER BY cand.available_at
  FOR UPDATE OF o SKIP LOCKED
  LIMIT ${p.limit}
)
UPDATE ${OUTBOX_TABLE} t
SET status = 'in_flight', locked_at = ${p.nowSet}, locked_by = ${p.lockedBy}
FROM locked
WHERE t.id = locked.id
RETURNING t.*`;
}

/**
 * Existence probe for the shared diagnose helpers. `to_regclass` resolves names through the
 * current `search_path`, exactly as migrate()'s unqualified DDL does, so diagnose stays
 * consistent with where the tables were actually created (no hard-coded `public` assumption).
 */
const DIAGNOSE_SQL = `SELECT
  to_regclass('${OUTBOX_TABLE}')    IS NOT NULL AS ${OUTBOX_TABLE},
  to_regclass('${ATTEMPTS_TABLE}')  IS NOT NULL AS ${ATTEMPTS_TABLE},
  to_regclass('${ENDPOINTS_TABLE}') IS NOT NULL AS ${ENDPOINTS_TABLE}`;

/** The Postgres dialect: the only SQL a relational adapter needs beyond the shared plumbing. */
export const postgres: SqlDialect = {
  name: "postgres",
  claimSql: {
    // pg bindings are `[now, limit, lockedBy]` ($1 is reused for both `now` slots).
    numbered: buildClaimSql({ now: "$1", limit: "$2", nowSet: "$1", lockedBy: "$3" }),
    // knex.raw bindings are `[now, limit, now, lockedBy]` (positional `?`, `now` appears twice).
    qmark: buildClaimSql({ now: "?", limit: "?", nowSet: "?", lockedBy: "?" }),
  },
  claimSqlPerEndpoint: {
    // pg bindings are `[now, limit, lockedBy]` ($1 is reused for every `now` slot).
    numbered: buildPerEndpointClaimSql({
      nowHead: "$1",
      nowInline: "$1",
      limit: "$2",
      nowSet: "$1",
      lockedBy: "$3",
    }),
    // knex.raw bindings are `[now, now, limit, now, lockedBy]` (positional `?`, in textual order).
    qmark: buildPerEndpointClaimSql({
      nowHead: "?",
      nowInline: "?",
      limit: "?",
      nowSet: "?",
      lockedBy: "?",
    }),
  },
  diagnoseSql: DIAGNOSE_SQL,
};
