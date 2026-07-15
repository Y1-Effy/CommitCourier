/**
 * Shared SQL store: a single {@link Store} implementation over a thin {@link SqlExecutor} seam.
 *
 * All four relational adapters (`pg`, `drizzle`, `prisma`, `knex`) speak Postgres and differ only in
 * *how* a statement runs — node-postgres `pool.query`, drizzle's `$client`, or Prisma's
 * `$queryRawUnsafe`/`$executeRawUnsafe`. {@link createSqlStore} captures the 23 non-`migrate` Store
 * methods once, against that seam, so the adapters stop re-implementing the same SQL and a new Store
 * method is written in exactly one place. The SQL itself is unchanged — it comes from the same
 * `./_shared` builders and `./sql/postgres` dialect the adapters already used.
 *
 * The seam always emits `$n` (numbered) placeholders. node-postgres/drizzle/Prisma bind those
 * directly; the knex adapter binds positional `?`, so its {@link SqlExecutor} translates each
 * statement with `numberedToQmark` just before `knex.raw` (its former query-builder implementation is
 * retired). So knex rides this seam too — it is not a separate implementation.
 *
 * `migrate()` is injected per adapter: the multi-statement (pg/drizzle/knex) vs split-statement
 * (prisma) protocols differ enough that forcing them through the seam would obscure more than it shares.
 */
import type { OutboxRow, DeliveryAttempt, EndpointRow, Transition } from "../core/index";
import type {
  Store,
  NewDeliveryAttempt,
  NewEndpointRow,
  EndpointPatch,
  ReplayFilter,
  OutboxStats,
  OutboxListFilter,
  EndpointListFilter,
} from "./store";
import {
  OUTBOX_TABLE,
  ATTEMPTS_TABLE,
  ENDPOINTS_TABLE,
  OUTBOX_COLUMNS,
  ATTEMPT_COLUMNS,
  ENDPOINT_COLUMNS,
  ENDPOINT_JSON_COLUMNS,
  isEndpointJsonColumn,
  outboxValues,
  outboxValuesStringified,
  attemptValues,
  attemptValuesStringified,
  endpointValues,
  endpointValuesStringified,
  endpointPatchColumns,
  endpointPatchObject,
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
  clampPruneLimit,
  countsFromRows,
  buildPruneSql,
  pruneParams,
  buildNoteEndpointFailureSql,
  noteEndpointFailureParams,
  GET_OUTBOX_SQL,
  CANCEL_PENDING_SQL,
  NOTE_ENDPOINT_SUCCESS_SQL,
  REACTIVATE_ENDPOINT_SQL,
  mapOutboxRow,
  mapAttemptRow,
  mapEndpointRow,
  mapOutboxListItem,
  diagnoseResult,
  existingFromRow,
  newId,
  type RawOutboxRow,
  type RawAttemptRow,
  type RawEndpointRow,
  type RawOutboxListRow,
  type RawEndpointSummaryRow,
} from "./_shared";
import { postgres } from "./sql/postgres";

/**
 * The per-adapter execution seam for the numbered (`$n`) Postgres family. An adapter provides this;
 * {@link createSqlStore} composes the Store semantics on top. All SQL passed here uses `$n`
 * placeholders and binds an ordered, positional param array.
 */
export interface SqlExecutor<TTx> {
  /**
   * Whether jsonb params are pre-stringified before binding. All bundled adapters set this `true`:
   * `JSON.stringify`-ing the value and binding it against the SQL's `::jsonb` cast is the only encoding
   * that round-trips every JSON payload — node-postgres' native param encoding (`false`) maps a JS `null`
   * to SQL NULL and mis-encodes a top-level JSON string/array, which the `NOT NULL` column and `::jsonb`
   * cast then reject. `false` relies on the driver serialising objects natively and does not support
   * non-object top-level payloads; it is retained only as a seam for a future non-Postgres binding.
   * Selects the ordered-value builder used for inserts/patches.
   */
  jsonAsText: boolean;
  /** Run a row-returning statement (SELECT, or a CTE/RETURNING that yields rows) and return the rows. */
  query<R>(sql: string, params: readonly unknown[]): Promise<R[]>;
  /** Run a mutation and return the number of rows it affected. */
  execute(sql: string, params: readonly unknown[]): Promise<number>;
  /** Run an enqueue-path INSERT on the caller's transaction handle (rides the user's TX, fail-closed). */
  insertOnTx(tx: TTx, sql: string, params: readonly unknown[]): Promise<void>;
  /** Run `fn` inside a fresh store-owned transaction (for the atomic replay-copy insert). */
  withTx<T>(fn: (tx: TTx) => Promise<T>): Promise<T>;
}

/**
 * Build a {@link Store} for a numbered-placeholder Postgres adapter from its {@link SqlExecutor} and
 * its `migrate` implementation. Implements every method except `migrate` once, so the `pg`, `drizzle`
 * and `prisma` adapters share identical semantics.
 */
export function createSqlStore<TTx>(
  exec: SqlExecutor<TTx>,
  migrate: () => Promise<void>,
): Store<TTx> {
  const INSERT_OUTBOX_SQL = insertClause(OUTBOX_TABLE, OUTBOX_COLUMNS, "payload");
  const INSERT_ATTEMPT_SQL = insertClause(ATTEMPTS_TABLE, ATTEMPT_COLUMNS, "request_headers");
  const INSERT_ENDPOINT_SQL = insertClause(
    ENDPOINTS_TABLE,
    ENDPOINT_COLUMNS,
    ENDPOINT_JSON_COLUMNS,
  );

  // Pick the ordered-value builder per the executor's jsonb binding convention.
  const outboxVals = exec.jsonAsText ? outboxValuesStringified : outboxValues;
  const attemptVals = exec.jsonAsText ? attemptValuesStringified : attemptValues;
  const endpointVals = exec.jsonAsText ? endpointValuesStringified : endpointValues;

  return {
    insertOutbox(trx, row) {
      // Ride the caller's TX: any error propagates so the user's TX rolls back (fail-closed).
      return exec.insertOnTx(trx, INSERT_OUTBOX_SQL, outboxVals(row));
    },

    async insertOutboxMany(trx, rows) {
      if (rows.length === 0) return; // no-op
      const sql = insertManyClause(OUTBOX_TABLE, OUTBOX_COLUMNS, "payload", rows.length);
      await exec.insertOnTx(
        trx,
        sql,
        rows.flatMap((r) => outboxVals(r)),
      );
    },

    async insertOutboxAutonomous(row) {
      await exec.execute(INSERT_OUTBOX_SQL, outboxVals(row));
    },

    async claimDue({ limit, lockedBy, now, ordering }): Promise<OutboxRow[]> {
      // Single atomic statement (CTE): SELECT ... FOR UPDATE SKIP LOCKED then UPDATE to in_flight.
      // Both variants share `[now, limit, lockedBy]` ($1 reused for every now slot).
      const sql = ordering === "per-endpoint" ? postgres.claimSqlPerEndpoint : postgres.claimSql;
      const rows = await exec.query<RawOutboxRow>(sql, [now, limit, lockedBy]);
      return rows.map(mapOutboxRow);
    },

    async applyTransition(id, t: Transition) {
      const { columns, values } = transitionColumns(t);
      // A transition with no fields to SET would render `SET ` (invalid SQL). Every core transition
      // sets at least `status`, so this is currently unreachable; guard defensively (symmetric with
      // updateEndpoint) so a future empty transition is a safe no-op rather than a runtime error.
      if (columns.length === 0) return;
      const set = columns.map((c, i) => `${c} = $${String(i + 2)}`).join(", ");
      // Idempotency guard: only act on a row still held in_flight.
      const sql = `UPDATE ${OUTBOX_TABLE} SET ${set} WHERE id = $1 AND status = 'in_flight'`;
      await exec.execute(sql, [id, ...values]);
    },

    async cancel(id): Promise<boolean> {
      // Guarded on pending so an in_flight/terminal row is never cancelled from under a delivery.
      const affected = await exec.execute(CANCEL_PENDING_SQL, [id]);
      return affected > 0;
    },

    async noteEndpointSuccess(id) {
      await exec.execute(NOTE_ENDPOINT_SUCCESS_SQL, [id]);
    },

    async noteEndpointFailure(id, now, threshold) {
      // Atomic increment + threshold auto-disable in one UPDATE; one builder shared by every adapter
      // (knex translates the numbered SQL to `?`) so the breaker logic has a single source of truth.
      await exec.execute(
        buildNoteEndpointFailureSql(),
        noteEndpointFailureParams(id, now, threshold),
      );
    },

    async reactivateEndpoint(id) {
      await exec.execute(REACTIVATE_ENDPOINT_SQL, [id]);
    },

    async reclaimStuck({ reclaimAfterMs, now }): Promise<number> {
      const cutoff = new Date(now.getTime() - reclaimAfterMs);
      const sql = `UPDATE ${OUTBOX_TABLE} SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE status = 'in_flight' AND locked_at < $1`;
      return exec.execute(sql, [cutoff]);
    },

    async recordAttempt(a: NewDeliveryAttempt) {
      await exec.execute(INSERT_ATTEMPT_SQL, attemptVals(newId(), a));
    },

    async completeAttempt(a: NewDeliveryAttempt, t: Transition, expectedLockedBy) {
      // One round trip via the shared CTE: INSERT the ledger row + apply the transition (guarded on
      // in_flight, and on locked_by when the claiming worker is known, so a reclaimed+re-locked row
      // is not clobbered). The affected count is 0 for a stale worker, 1 when it still owned the row.
      const { columns, values } = transitionColumns(t);
      // The ledger INSERT must always happen, but an empty transition would render an invalid `SET `
      // in the CTE. Every core transition sets at least `status`, so this is currently unreachable;
      // guard defensively by recording just the ledger row (no transition), mirroring the stale-lease
      // outcome (`transitionApplied: false`).
      if (columns.length === 0) {
        await exec.execute(INSERT_ATTEMPT_SQL, attemptVals(newId(), a));
        return { transitionApplied: false };
      }
      const guardLockedBy = expectedLockedBy != null;
      const sql = completeAttemptSql(columns, { guardLockedBy });
      const params = [...attemptVals(newId(), a), ...values, a.outboxId];
      if (guardLockedBy) params.push(expectedLockedBy);
      const affected = await exec.execute(sql, params);
      return { transitionApplied: affected > 0 };
    },

    async queryAttempts({ outboxId }): Promise<DeliveryAttempt[]> {
      const sql = `SELECT * FROM ${ATTEMPTS_TABLE} WHERE outbox_id = $1 ORDER BY attempt_no`;
      const rows = await exec.query<RawAttemptRow>(sql, [outboxId]);
      return rows.map(mapAttemptRow);
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
      const rows = await exec.query<RawOutboxRow>(sql, params);
      return rows.map(mapOutboxRow);
    },

    async insertReplayCopies(rows): Promise<string[]> {
      await exec.withTx(async (tx) => {
        for (const row of rows) {
          await exec.insertOnTx(tx, INSERT_OUTBOX_SQL, outboxVals(row));
        }
      });
      return rows.map((r) => r.id);
    },

    async getOutbox(id) {
      const rows = await exec.query<RawOutboxListRow>(GET_OUTBOX_SQL, [id]);
      const row = rows[0];
      return row ? mapOutboxListItem(row) : null;
    },

    async prune({ olderThan, statuses, limit }) {
      if (statuses.length === 0) return { deleted: 0 };
      // Defence in depth (the admin layer already validates statuses and clamps): the SQL itself never
      // deletes an active row (an always-on `status NOT IN ('pending','in_flight')` guard), and the batch
      // size is clamped here too, so a direct store caller cannot issue an unbounded DELETE.
      const sql = buildPruneSql(statuses.length);
      const deleted = await exec.execute(
        sql,
        pruneParams(statuses, olderThan, clampPruneLimit(limit)),
      );
      return { deleted };
    },

    async listOutbox(filter: OutboxListFilter) {
      const { sql, params } = buildOutboxListQuery(filter);
      const rows = await exec.query<RawOutboxListRow>(sql, params);
      return outboxListPage(rows, clampListLimit(filter.limit));
    },

    async listEndpoints(filter: EndpointListFilter) {
      const { sql, params } = buildEndpointListQuery(filter);
      const rows = await exec.query<RawEndpointSummaryRow>(sql, params);
      return endpointListPage(rows, clampListLimit(filter.limit));
    },

    async insertEndpoint(ep: NewEndpointRow) {
      await exec.execute(INSERT_ENDPOINT_SQL, endpointVals(ep));
    },

    async updateEndpoint(id, patch: EndpointPatch) {
      const { columns, values: rawValues } = endpointPatchColumns(patch);
      if (columns.length === 0) return; // no-op patch
      const set = columns
        .map((c, i) => `${c} = $${String(i + 2)}${isEndpointJsonColumn(c) ? "::jsonb" : ""}`)
        .join(", ");
      const values = exec.jsonAsText
        ? columns.map((c) => endpointPatchObject(patch)[c])
        : rawValues;
      await exec.execute(`UPDATE ${ENDPOINTS_TABLE} SET ${set} WHERE id = $1`, [id, ...values]);
    },

    async findEndpoint(id): Promise<EndpointRow | null> {
      const rows = await exec.query<RawEndpointRow>(
        `SELECT * FROM ${ENDPOINTS_TABLE} WHERE id = $1`,
        [id],
      );
      return rows[0] ? mapEndpointRow(rows[0]) : null;
    },

    async disableEndpoint(id, now) {
      await exec.execute(
        `UPDATE ${ENDPOINTS_TABLE} SET status = 'disabled', disabled_at = $2 WHERE id = $1`,
        [id, now],
      );
    },

    async stats(): Promise<OutboxStats> {
      const counts = await exec.query<{ status: string; count: number | string | bigint }>(
        `SELECT status, count(*) AS count FROM ${OUTBOX_TABLE} GROUP BY status`,
        [],
      );
      const oldest = await exec.query<{ oldest: Date | null }>(
        `SELECT min(available_at) AS oldest FROM ${OUTBOX_TABLE} WHERE status = 'pending'`,
        [],
      );
      return {
        counts: countsFromRows(counts.map((r) => ({ status: r.status, count: Number(r.count) }))),
        oldestPendingAt: oldest[0]?.oldest ?? null,
      };
    },

    async diagnose() {
      const rows = await exec.query<Record<string, unknown>>(postgres.diagnoseSql, []);
      return diagnoseResult(existingFromRow(rows[0] ?? {}));
    },

    migrate,
  };
}
