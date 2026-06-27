/**
 * Prisma adapter (per 02-store section 3.4). `prismaStore({ prisma })`.
 *
 * `TTx = PrismaTx` (a Prisma interactive-transaction client): `insertOutbox` runs on the caller's
 * `prisma.$transaction(async (tx) => …)` client and joins the user's TX (fail-closed); dispatch/admin
 * methods use the injected client directly. Prisma speaks Postgres, so the adapter reuses the exact
 * Postgres dialect SQL and the shared row/column plumbing as the `pg` adapter — only the execution
 * seam differs: raw SQL runs via `$queryRawUnsafe` / `$executeRawUnsafe` (which keep the `$n`
 * placeholders, so the dialect SQL is passed verbatim with positional values).
 *
 * Prisma is typed structurally here (no `@prisma/client` import) so this module builds without Prisma
 * installed; `@prisma/client` is an optional peer dependency. jsonb params are stringified (Prisma
 * binds them as text and the `::jsonb` cast in the SQL converts them), as in the knex adapter.
 */
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
  outboxValuesStringified,
  attemptValuesStringified,
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
  countsFromRows,
  mapOutboxRow,
  mapAttemptRow,
  mapEndpointRow,
  mapOutboxListItem,
  diagnoseResult,
  existingFromRow,
  applyMigrations,
  migrationScript,
  splitStatements,
  ADVISORY_LOCK_SQL,
  MIGRATIONS_TABLE_DDL,
  SELECT_APPLIED_MIGRATIONS_SQL,
  CANCEL_PENDING_SQL,
  GET_OUTBOX_SQL,
  NOTE_ENDPOINT_SUCCESS_SQL,
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

/** The Prisma raw-query surface the adapter uses (a `PrismaClient` or its transaction client). */
export interface PrismaRaw {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T[]>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** A Prisma client: raw queries plus interactive transactions. */
export interface PrismaClientLike extends PrismaRaw {
  $transaction<T>(fn: (tx: PrismaRaw) => Promise<T>): Promise<T>;
}

/** The interactive-transaction client Prisma passes to `$transaction` (the `enqueue` TTx). */
export type PrismaTx = PrismaRaw;

const INSERT_OUTBOX_SQL = insertClause(OUTBOX_TABLE, OUTBOX_COLUMNS, "payload");
const INSERT_ATTEMPT_SQL = insertClause(ATTEMPTS_TABLE, ATTEMPT_COLUMNS, "request_headers");
const INSERT_ENDPOINT_SQL = insertClause(ENDPOINTS_TABLE, ENDPOINT_COLUMNS, ENDPOINT_JSON_COLUMN);

/** Registered-endpoint admin + stats methods, factored out to keep the store factory small. */
function endpointAndStatsMethods(
  prisma: PrismaRaw,
): Pick<Store, "insertEndpoint" | "updateEndpoint" | "findEndpoint" | "disableEndpoint" | "stats"> {
  return {
    async insertEndpoint(ep: NewEndpointRow) {
      await prisma.$executeRawUnsafe(INSERT_ENDPOINT_SQL, ...endpointValuesStringified(ep));
    },

    async updateEndpoint(id, patch: EndpointPatch) {
      const { columns } = endpointPatchColumns(patch);
      if (columns.length === 0) return; // no-op patch
      const obj = endpointPatchObject(patch); // jsonb columns stringified
      const set = columns
        .map((c, i) => `${c} = $${String(i + 2)}${c === ENDPOINT_JSON_COLUMN ? "::jsonb" : ""}`)
        .join(", ");
      const values = columns.map((c) => obj[c]);
      await prisma.$executeRawUnsafe(
        `UPDATE ${ENDPOINTS_TABLE} SET ${set} WHERE id = $1`,
        id,
        ...values,
      );
    },

    async findEndpoint(id): Promise<EndpointRow | null> {
      const rows = await prisma.$queryRawUnsafe<RawEndpointRow>(
        `SELECT * FROM ${ENDPOINTS_TABLE} WHERE id = $1`,
        id,
      );
      const row = rows[0];
      return row ? mapEndpointRow(row) : null;
    },

    async disableEndpoint(id, now) {
      const sql = `UPDATE ${ENDPOINTS_TABLE} SET status = 'disabled', disabled_at = $2 WHERE id = $1`;
      await prisma.$executeRawUnsafe(sql, id, now);
    },

    async stats(): Promise<OutboxStats> {
      const counts = await prisma.$queryRawUnsafe<{ status: string; count: bigint | string }>(
        `SELECT status, count(*) AS count FROM ${OUTBOX_TABLE} GROUP BY status`,
      );
      const oldest = await prisma.$queryRawUnsafe<{ oldest: Date | null }>(
        `SELECT min(available_at) AS oldest FROM ${OUTBOX_TABLE} WHERE status = 'pending'`,
      );
      return {
        counts: countsFromRows(counts.map((r) => ({ status: r.status, count: Number(r.count) }))),
        oldestPendingAt: oldest[0]?.oldest ?? null,
      };
    },
  };
}

/**
 * Build a {@link Store} backed by Prisma. `enqueue(trx, …)` takes a Prisma interactive-transaction
 * client so the outbox write rides the caller's transaction (fail-closed); dispatch/admin methods
 * use the injected client. Semantics match the `pg` adapter (same dialect SQL).
 *
 * @param opts - Holds the `PrismaClient` (the `@prisma/client` peer dependency must be installed).
 * @returns A `Store<PrismaTx>` to pass to `createRelay`.
 */
export function prismaStore(opts: { prisma: PrismaClientLike }): Store<PrismaTx> {
  const { prisma } = opts;

  return {
    async insertOutbox(trx, row) {
      // Ride the caller's TX: any error propagates so the user's TX rolls back (fail-closed).
      await trx.$executeRawUnsafe(INSERT_OUTBOX_SQL, ...outboxValuesStringified(row));
    },

    async insertOutboxMany(trx, rows) {
      if (rows.length === 0) return; // no-op
      const sql = insertManyClause(OUTBOX_TABLE, OUTBOX_COLUMNS, "payload", rows.length);
      await trx.$executeRawUnsafe(sql, ...rows.flatMap((r) => outboxValuesStringified(r)));
    },

    async insertOutboxAutonomous(row) {
      await prisma.$executeRawUnsafe(INSERT_OUTBOX_SQL, ...outboxValuesStringified(row));
    },

    async claimDue({ limit, lockedBy, now, ordering }): Promise<OutboxRow[]> {
      // Single atomic statement (CTE): SELECT ... FOR UPDATE SKIP LOCKED then UPDATE to in_flight.
      // `$1` (now) is reused across slots; Postgres binds it from the single positional value.
      const numbered =
        ordering === "per-endpoint"
          ? postgres.claimSqlPerEndpoint.numbered
          : postgres.claimSql.numbered;
      const rows = await prisma.$queryRawUnsafe<RawOutboxRow>(numbered, now, limit, lockedBy);
      return rows.map(mapOutboxRow);
    },

    async applyTransition(id, t: Transition) {
      const { columns, values } = transitionColumns(t);
      const set = columns.map((c, i) => `${c} = $${String(i + 2)}`).join(", ");
      // Idempotency guard: only act on a row still held in_flight.
      const sql = `UPDATE ${OUTBOX_TABLE} SET ${set} WHERE id = $1 AND status = 'in_flight'`;
      await prisma.$executeRawUnsafe(sql, id, ...values);
    },

    async cancel(id): Promise<boolean> {
      // Guarded on pending so an in_flight/terminal row is never cancelled from under a delivery.
      const affected = await prisma.$executeRawUnsafe(CANCEL_PENDING_SQL, id);
      return affected > 0;
    },

    async noteEndpointSuccess(id) {
      await prisma.$executeRawUnsafe(NOTE_ENDPOINT_SUCCESS_SQL, id);
    },

    async noteEndpointFailure(id, now, threshold) {
      await prisma.$executeRawUnsafe(
        buildNoteEndpointFailureSql("numbered"),
        ...noteEndpointFailureParams("numbered", id, now, threshold),
      );
    },

    async reclaimStuck({ reclaimAfterMs, now }): Promise<number> {
      const cutoff = new Date(now.getTime() - reclaimAfterMs);
      const sql = `UPDATE ${OUTBOX_TABLE} SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE status = 'in_flight' AND locked_at < $1`;
      return prisma.$executeRawUnsafe(sql, cutoff);
    },

    async recordAttempt(a: NewDeliveryAttempt) {
      await prisma.$executeRawUnsafe(INSERT_ATTEMPT_SQL, ...attemptValuesStringified(newId(), a));
    },

    async completeAttempt(a: NewDeliveryAttempt, t: Transition, expectedLockedBy) {
      // One round trip via the shared CTE: INSERT the ledger row + apply the transition (guarded on
      // in_flight, and on locked_by when the claiming worker is known).
      const { columns, values } = transitionColumns(t);
      const guardLockedBy = expectedLockedBy != null;
      const sql = completeAttemptSql(columns, "numbered", { guardLockedBy });
      const params = [...attemptValuesStringified(newId(), a), ...values, a.outboxId];
      if (guardLockedBy) params.push(expectedLockedBy);
      await prisma.$executeRawUnsafe(sql, ...params);
    },

    async queryAttempts({ outboxId }): Promise<DeliveryAttempt[]> {
      const sql = `SELECT * FROM ${ATTEMPTS_TABLE} WHERE outbox_id = $1 ORDER BY attempt_no`;
      const rows = await prisma.$queryRawUnsafe<RawAttemptRow>(sql, outboxId);
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
      const rows = await prisma.$queryRawUnsafe<RawOutboxRow>(sql, ...params);
      return rows.map(mapOutboxRow);
    },

    async getOutbox(id) {
      const rows = await prisma.$queryRawUnsafe<RawOutboxListRow>(GET_OUTBOX_SQL, id);
      const row = rows[0];
      return row ? mapOutboxListItem(row) : null;
    },

    async prune({ olderThan, statuses, limit }) {
      if (statuses.length === 0) return { deleted: 0 };
      const sql = buildPruneSql(statuses.length, "numbered");
      const deleted = await prisma.$executeRawUnsafe(
        sql,
        ...pruneParams(statuses, olderThan, limit),
      );
      return { deleted };
    },

    async insertReplayCopies(rows): Promise<string[]> {
      await prisma.$transaction(async (tx) => {
        for (const row of rows) {
          await tx.$executeRawUnsafe(INSERT_OUTBOX_SQL, ...outboxValuesStringified(row));
        }
      });
      return rows.map((r) => r.id);
    },

    async listOutbox(filter: OutboxListFilter) {
      const { sql, params } = buildOutboxListQuery(filter, "numbered");
      const rows = await prisma.$queryRawUnsafe<RawOutboxListRow>(sql, ...params);
      return outboxListPage(rows, clampListLimit(filter.limit));
    },

    async listEndpoints(filter: EndpointListFilter) {
      const { sql, params } = buildEndpointListQuery(filter, "numbered");
      const rows = await prisma.$queryRawUnsafe<RawEndpointSummaryRow>(sql, ...params);
      return endpointListPage(rows, clampListLimit(filter.limit));
    },

    ...endpointAndStatsMethods(prisma),

    async diagnose() {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>>(postgres.diagnoseSql);
      return diagnoseResult(existingFromRow(rows[0] ?? {}));
    },

    async migrate() {
      await applyMigrations({
        // Prisma cannot run a multi-statement string, so take the advisory lock and create the table
        // as two statements inside one interactive transaction (lock held through the CREATE), which
        // serialises concurrent migrators.
        ensureTable: () =>
          prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(ADVISORY_LOCK_SQL);
            await tx.$executeRawUnsafe(MIGRATIONS_TABLE_DDL);
          }),
        appliedNames: async () => {
          const rows = await prisma.$queryRawUnsafe<{ name: string }>(
            SELECT_APPLIED_MIGRATIONS_SQL,
          );
          return new Set(rows.map((r) => r.name));
        },
        // Prisma runs one statement per raw call, so split the script (advisory lock + DDL + record
        // INSERT) and apply it in order inside one interactive transaction (the lock lands first).
        apply: (m) =>
          prisma.$transaction(async (tx) => {
            for (const statement of splitStatements(migrationScript(m))) {
              await tx.$executeRawUnsafe(statement);
            }
          }),
      });
    },
  };
}
