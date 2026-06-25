/**
 * Postgres SQL dialect (per the store-generalization design).
 *
 * Holds the Postgres-specific SQL that was previously inlined in `../_shared`: the claim CTE
 * (`FOR UPDATE SKIP LOCKED` + `RETURNING`), the `to_regclass` existence probe, and the DDL.
 * The shared row/column plumbing and the DDL file loader stay in `../_shared`; `ddl()` delegates
 * to {@link loadInitSql} so the `import.meta.url`-relative DDL path is unaffected.
 */
import { OUTBOX_TABLE, ATTEMPTS_TABLE, ENDPOINTS_TABLE, loadInitSql } from "../_shared";
import type { SqlDialect } from "./dialect";

interface ClaimPlaceholders {
  now: string;
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
  diagnoseSql: DIAGNOSE_SQL,
  ddl: loadInitSql,
};
