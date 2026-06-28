/**
 * Drizzle adapter. `drizzleStore({ db })`.
 *
 * `TTx = DrizzleTx` (a drizzle node-postgres transaction): `insertOutbox` runs on the caller's
 * drizzle transaction and joins the user's TX (fail-closed). Drizzle sits on node-postgres, so the
 * adapter reuses the exact Postgres dialect SQL and the shared row/column plumbing as the `pg`
 * adapter.
 *
 * Execution seam: drizzle's `execute` overrides node-postgres' type parsers and returns timestamps as
 * raw strings (it maps them in its ORM layer, which we bypass). So row-reading dispatch/admin methods
 * run through the underlying `$client` (node-postgres' default parsers → `Date`), exactly like the pg
 * adapter; only the enqueue-path writes — which bind params and read no rows — use the drizzle
 * transaction handle so they ride the caller's transaction. `drizzle-orm` is an optional peer
 * dependency (types only; the db is injected).
 */
import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { OutboxRow, DeliveryAttempt, EndpointRow, Transition } from "../core/index";
import type {
  NewDeliveryAttempt,
  NewEndpointRow,
  EndpointPatch,
  ReplayFilter,
  OutboxStats,
  OutboxListFilter,
  EndpointListFilter,
  Store,
} from "./store";
import {
  OUTBOX_TABLE,
  ATTEMPTS_TABLE,
  ENDPOINTS_TABLE,
  OUTBOX_COLUMNS,
  ATTEMPT_COLUMNS,
  ENDPOINT_COLUMNS,
  ENDPOINT_JSON_COLUMN,
  outboxValues,
  attemptValues,
  endpointValues,
  endpointPatchColumns,
  transitionColumns,
  completeAttemptSql,
  insertClause,
  insertManyClause,
  replayWhere,
  buildOutboxListQuery,
  buildEndpointListQuery,
  outboxListPage,
  endpointListPage,
  clampListLimit,
  countsFromRows,
  mapOutboxRow,
  mapAttemptRow,
  mapEndpointRow,
  mapOutboxListItem,
  diagnoseResult,
  existingFromRow,
  applyMigrations,
  migrationScript,
  migrationsTableScript,
  SELECT_APPLIED_MIGRATIONS_SQL,
  CANCEL_PENDING_SQL,
  GET_OUTBOX_SQL,
  NOTE_ENDPOINT_SUCCESS_SQL,
  REACTIVATE_ENDPOINT_SQL,
  buildNoteEndpointFailureSql,
  noteEndpointFailureParams,
  buildPruneSql,
  pruneParams,
  newId,
  type RawOutboxRow,
  type RawAttemptRow,
  type RawEndpointRow,
  type RawOutboxListRow,
  type RawEndpointSummaryRow,
} from "./_shared";
import { postgres } from "./sql/postgres";

/** The node-postgres client surface (`Pool` or `Client`) drizzle exposes as `$client`. */
type PgClient = {
  query(text: string, params?: unknown[]): Promise<{ rows?: unknown[]; rowCount?: number | null }>;
};

/** A drizzle node-postgres database, plus the `$client` exposed by the `drizzle()` factory. */
export type DrizzleDb = NodePgDatabase & { $client: PgClient };

/** The transaction handle drizzle passes to a `db.transaction` callback (the `enqueue` TTx). */
export type DrizzleTx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

/** The drizzle executor surface used for enqueue-path writes (satisfied by {@link DrizzleTx}). */
type Executor = { execute(query: SQL): Promise<unknown> };

const INSERT_OUTBOX_SQL = insertClause(OUTBOX_TABLE, OUTBOX_COLUMNS, "payload");
const INSERT_ATTEMPT_SQL = insertClause(ATTEMPTS_TABLE, ATTEMPT_COLUMNS, "request_headers");
const INSERT_ENDPOINT_SQL = insertClause(ENDPOINTS_TABLE, ENDPOINT_COLUMNS, ENDPOINT_JSON_COLUMN);

/**
 * Turn a numbered (`$1`, `$2`, …) SQL string and its ordered params into a drizzle `SQL` object.
 * Each `$n` occurrence binds `params[n-1]` as its own parameter (a reused `$1` simply binds the same
 * value again), so the shared dialect SQL — including its reused `now` slots — works unchanged. Only
 * used for enqueue-path writes on the caller's transaction (which read no rows).
 */
function toSql(numbered: string, params: readonly unknown[]): SQL {
  const chunks: SQL[] = [];
  const re = /\$(\d+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(numbered)) !== null) {
    if (m.index > last) chunks.push(sql.raw(numbered.slice(last, m.index)));
    chunks.push(sql`${params[Number(m[1]) - 1]}`);
    last = m.index + m[0].length;
  }
  if (last < numbered.length) chunks.push(sql.raw(numbered.slice(last)));
  return sql.join(chunks);
}

/** Registered-endpoint admin + stats methods, factored out to keep the store factory small. */
function endpointAndStatsMethods(
  client: PgClient,
): Pick<Store, "insertEndpoint" | "updateEndpoint" | "findEndpoint" | "disableEndpoint" | "stats"> {
  return {
    async insertEndpoint(ep: NewEndpointRow) {
      await client.query(INSERT_ENDPOINT_SQL, endpointValues(ep));
    },

    async updateEndpoint(id, patch: EndpointPatch) {
      const { columns, values } = endpointPatchColumns(patch);
      if (columns.length === 0) return; // no-op patch
      const set = columns
        .map((c, i) => `${c} = $${String(i + 2)}${c === ENDPOINT_JSON_COLUMN ? "::jsonb" : ""}`)
        .join(", ");
      await client.query(`UPDATE ${ENDPOINTS_TABLE} SET ${set} WHERE id = $1`, [id, ...values]);
    },

    async findEndpoint(id): Promise<EndpointRow | null> {
      const res = await client.query(`SELECT * FROM ${ENDPOINTS_TABLE} WHERE id = $1`, [id]);
      const row = (res.rows as RawEndpointRow[] | undefined)?.[0];
      return row ? mapEndpointRow(row) : null;
    },

    async disableEndpoint(id, now) {
      const sql = `UPDATE ${ENDPOINTS_TABLE} SET status = 'disabled', disabled_at = $2 WHERE id = $1`;
      await client.query(sql, [id, now]);
    },

    async stats(): Promise<OutboxStats> {
      const counts = await client.query(
        `SELECT status, count(*) AS count FROM ${OUTBOX_TABLE} GROUP BY status`,
      );
      const oldest = await client.query(
        `SELECT min(available_at) AS oldest FROM ${OUTBOX_TABLE} WHERE status = 'pending'`,
      );
      const oldestPendingAt =
        (oldest.rows as { oldest: Date | null }[] | undefined)?.[0]?.oldest ?? null;
      return {
        counts: countsFromRows((counts.rows ?? []) as { status: string; count: string }[]),
        oldestPendingAt,
      };
    },
  };
}

/**
 * Build a {@link Store} backed by Drizzle (node-postgres). `enqueue(trx, …)` takes a drizzle
 * transaction so the outbox write rides the caller's transaction (fail-closed); dispatch/admin
 * methods run on the underlying `$client`. Semantics match the `pg` adapter (same dialect SQL and
 * driver-level type parsing).
 *
 * @param opts - Holds the drizzle database (built with `drizzle(pool)`, so `$client` is present).
 * @returns A `Store<DrizzleTx>` to pass to `createRelay`.
 */
export function drizzleStore(opts: { db: DrizzleDb }): Store<DrizzleTx> {
  const { db } = opts;
  const client = db.$client;

  /** Insert (enqueue-path) on the caller's drizzle transaction; reads no rows. */
  const insertOn = (trx: Executor, text: string, params: readonly unknown[]): Promise<unknown> =>
    trx.execute(toSql(text, params));

  return {
    async insertOutbox(trx, row) {
      // Ride the caller's TX: any error propagates so the user's TX rolls back (fail-closed).
      await insertOn(trx, INSERT_OUTBOX_SQL, outboxValues(row));
    },

    async insertOutboxMany(trx, rows) {
      if (rows.length === 0) return; // no-op
      const sql = insertManyClause(OUTBOX_TABLE, OUTBOX_COLUMNS, "payload", rows.length);
      await insertOn(
        trx,
        sql,
        rows.flatMap((r) => outboxValues(r)),
      );
    },

    async insertOutboxAutonomous(row) {
      await client.query(INSERT_OUTBOX_SQL, outboxValues(row));
    },

    async claimDue({ limit, lockedBy, now, ordering }): Promise<OutboxRow[]> {
      // Single atomic statement (CTE): SELECT ... FOR UPDATE SKIP LOCKED then UPDATE to in_flight.
      // Both variants share `[now, limit, lockedBy]` ($1 reused for every now slot).
      const numbered =
        ordering === "per-endpoint"
          ? postgres.claimSqlPerEndpoint.numbered
          : postgres.claimSql.numbered;
      const res = await client.query(numbered, [now, limit, lockedBy]);
      return ((res.rows ?? []) as RawOutboxRow[]).map(mapOutboxRow);
    },

    async applyTransition(id, t: Transition) {
      const { columns, values } = transitionColumns(t);
      const set = columns.map((c, i) => `${c} = $${String(i + 2)}`).join(", ");
      // Idempotency guard: only act on a row still held in_flight.
      const sql = `UPDATE ${OUTBOX_TABLE} SET ${set} WHERE id = $1 AND status = 'in_flight'`;
      await client.query(sql, [id, ...values]);
    },

    async cancel(id): Promise<boolean> {
      // Guarded on pending so an in_flight/terminal row is never cancelled from under a delivery.
      const res = await client.query(CANCEL_PENDING_SQL, [id]);
      return (res.rowCount ?? 0) > 0;
    },

    async noteEndpointSuccess(id) {
      await client.query(NOTE_ENDPOINT_SUCCESS_SQL, [id]);
    },

    async noteEndpointFailure(id, now, threshold) {
      await client.query(
        buildNoteEndpointFailureSql("numbered"),
        noteEndpointFailureParams("numbered", id, now, threshold),
      );
    },

    async reactivateEndpoint(id) {
      await client.query(REACTIVATE_ENDPOINT_SQL, [id]);
    },

    async reclaimStuck({ reclaimAfterMs, now }): Promise<number> {
      const cutoff = new Date(now.getTime() - reclaimAfterMs);
      const sql = `UPDATE ${OUTBOX_TABLE} SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE status = 'in_flight' AND locked_at < $1`;
      const res = await client.query(sql, [cutoff]);
      return res.rowCount ?? 0;
    },

    async recordAttempt(a: NewDeliveryAttempt) {
      await client.query(INSERT_ATTEMPT_SQL, attemptValues(newId(), a));
    },

    async completeAttempt(a: NewDeliveryAttempt, t: Transition, expectedLockedBy) {
      // One round trip via the shared CTE: INSERT the ledger row + apply the transition (guarded on
      // in_flight, and on locked_by when the claiming worker is known).
      const { columns, values } = transitionColumns(t);
      const guardLockedBy = expectedLockedBy != null;
      const sql = completeAttemptSql(columns, "numbered", { guardLockedBy });
      const params = [...attemptValues(newId(), a), ...values, a.outboxId];
      if (guardLockedBy) params.push(expectedLockedBy);
      // rowCount is the affected count of the CTE's top-level UPDATE: 0 when the guard matched no row
      // (stale worker reclaimed), 1 when this worker still owned the row.
      const res = await client.query(sql, params);
      return { transitionApplied: (res.rowCount ?? 0) > 0 };
    },

    async queryAttempts({ outboxId }): Promise<DeliveryAttempt[]> {
      const sql = `SELECT * FROM ${ATTEMPTS_TABLE} WHERE outbox_id = $1 ORDER BY attempt_no`;
      const res = await client.query(sql, [outboxId]);
      return ((res.rows ?? []) as RawAttemptRow[]).map(mapAttemptRow);
    },

    async selectForReplay(filter: ReplayFilter): Promise<OutboxRow[]> {
      const where = replayWhere(filter);
      const params = [...where.params];
      let limit = "";
      if (filter.limit !== undefined) {
        params.push(filter.limit);
        limit = ` LIMIT $${String(params.length)}`;
      }
      const sql = `SELECT * FROM ${OUTBOX_TABLE} ${where.sql} ORDER BY created_at${limit}`;
      const res = await client.query(sql, params);
      return ((res.rows ?? []) as RawOutboxRow[]).map(mapOutboxRow);
    },

    async getOutbox(id) {
      const res = await client.query(GET_OUTBOX_SQL, [id]);
      const row = ((res.rows ?? []) as RawOutboxListRow[])[0];
      return row ? mapOutboxListItem(row) : null;
    },

    async prune({ olderThan, statuses, limit }) {
      if (statuses.length === 0) return { deleted: 0 };
      const sql = buildPruneSql(statuses.length, "numbered");
      const res = await client.query(sql, pruneParams(statuses, olderThan, limit));
      return { deleted: res.rowCount ?? 0 };
    },

    async insertReplayCopies(rows): Promise<string[]> {
      await db.transaction(async (tx) => {
        for (const row of rows) {
          await insertOn(tx, INSERT_OUTBOX_SQL, outboxValues(row));
        }
      });
      return rows.map((r) => r.id);
    },

    async listOutbox(filter: OutboxListFilter) {
      const { sql, params } = buildOutboxListQuery(filter, "numbered");
      const res = await client.query(sql, params);
      return outboxListPage((res.rows ?? []) as RawOutboxListRow[], clampListLimit(filter.limit));
    },

    async listEndpoints(filter: EndpointListFilter) {
      const { sql, params } = buildEndpointListQuery(filter, "numbered");
      const res = await client.query(sql, params);
      return endpointListPage(
        (res.rows ?? []) as RawEndpointSummaryRow[],
        clampListLimit(filter.limit),
      );
    },

    ...endpointAndStatsMethods(client),

    async diagnose() {
      const res = await client.query(postgres.diagnoseSql);
      const row = ((res.rows ?? []) as Record<string, unknown>[])[0] ?? {};
      return diagnoseResult(existingFromRow(row));
    },

    async migrate() {
      await applyMigrations({
        // The simple query protocol ($client.query with no params) runs a multi-statement script as
        // one implicit transaction (advisory lock + DDL), so concurrent ensureTable calls serialise.
        ensureTable: async () => {
          await client.query(migrationsTableScript());
        },
        appliedNames: async () => {
          const res = await client.query(SELECT_APPLIED_MIGRATIONS_SQL);
          return new Set(((res.rows ?? []) as { name: string }[]).map((r) => r.name));
        },
        // The script is multiple statements; the simple query protocol runs them as one implicit
        // transaction (drizzle's execute uses the extended protocol, which rejects multi-statement).
        // Advisory lock + DDL + record INSERT therefore commit atomically and serialise.
        apply: async (m) => {
          await client.query(migrationScript(m));
        },
      });
    },
  };
}
