/**
 * knex adapter (per 02-store section 3.2). `knexStore({ knex })`.
 *
 * `TTx = Knex.Transaction`: `insertOutbox` runs on the caller's transaction (fail-closed).
 * dispatch-path methods open their own transaction. Semantics match the pg adapter: the claim
 * uses the shared CTE via `raw`. `knex` is an optional peer dependency (types only; injected).
 */
import type { Knex } from "knex";
import type { OutboxRow, DeliveryAttempt, EndpointRow, Transition } from "../core/index";
import type {
  NewDeliveryAttempt,
  NewEndpointRow,
  EndpointPatch,
  ReplayFilter,
  OutboxStats,
  Store,
} from "./store";
import {
  OUTBOX_TABLE,
  ATTEMPTS_TABLE,
  ENDPOINTS_TABLE,
  outboxObject,
  attemptObject,
  endpointObject,
  endpointPatchObject,
  transitionColumns,
  completeAttemptSql,
  attemptValuesStringified,
  countsFromRows,
  mapOutboxRow,
  mapAttemptRow,
  mapEndpointRow,
  diagnoseResult,
  existingFromRow,
  newId,
  type RawOutboxRow,
  type RawAttemptRow,
  type RawEndpointRow,
} from "./_shared";
import { postgres } from "./sql/postgres";

/** Apply a {@link ReplayFilter}'s conditions to a knex query builder. */
function applyReplayFilter(q: Knex.QueryBuilder, filter: ReplayFilter): Knex.QueryBuilder {
  let out = q;
  if (filter.outboxId !== undefined) out = out.where("id", filter.outboxId);
  if (filter.status !== undefined) out = out.where("status", filter.status);
  if (filter.since !== undefined) out = out.where("created_at", ">=", filter.since);
  return out;
}

/** Registered-endpoint admin + stats methods, factored out to keep the store factory small. */
function endpointAndStatsMethods(
  knex: Knex,
): Pick<Store, "insertEndpoint" | "updateEndpoint" | "findEndpoint" | "disableEndpoint" | "stats"> {
  return {
    async insertEndpoint(ep: NewEndpointRow) {
      await knex(ENDPOINTS_TABLE).insert(endpointObject(ep));
    },

    async updateEndpoint(id, patch: EndpointPatch) {
      const set = endpointPatchObject(patch);
      if (Object.keys(set).length === 0) return; // no-op patch
      await knex(ENDPOINTS_TABLE).where("id", id).update(set);
    },

    async findEndpoint(id): Promise<EndpointRow | null> {
      const row = (await knex(ENDPOINTS_TABLE).where("id", id).first()) as
        | RawEndpointRow
        | undefined;
      return row ? mapEndpointRow(row) : null;
    },

    async disableEndpoint(id, now) {
      await knex(ENDPOINTS_TABLE).where("id", id).update({ status: "disabled", disabled_at: now });
    },

    async stats(): Promise<OutboxStats> {
      const rows = await knex(OUTBOX_TABLE).select("status").count("* as count").groupBy("status");
      const oldest = (await knex(OUTBOX_TABLE)
        .where("status", "pending")
        .min("available_at as oldest")
        .first()) as { oldest: Date | null } | undefined;
      return {
        counts: countsFromRows(rows as unknown as { status: string; count: number | string }[]),
        oldestPendingAt: oldest?.oldest ?? null,
      };
    },
  };
}

/**
 * Build a {@link Store} backed by Knex. `enqueue(trx, …)` takes a `Knex.Transaction` so the
 * outbox write rides the caller's transaction (fail-closed); dispatch-path methods open their
 * own transaction off the injected `knex` instance.
 *
 * @param opts - Holds the configured Knex instance (the `knex` peer dependency must be installed).
 * @returns A `Store<Knex.Transaction>` to pass to `createRelay`.
 */
export function knexStore(opts: { knex: Knex }): Store<Knex.Transaction> {
  const { knex } = opts;

  return {
    async insertOutbox(trx, row) {
      // Ride the caller's transaction; errors propagate so the user's TX rolls back (fail-closed).
      await trx(OUTBOX_TABLE).insert(outboxObject(row));
    },

    async insertOutboxMany(trx, rows) {
      if (rows.length === 0) return; // no-op
      // knex collapses an array insert into a single multi-row INSERT statement.
      await trx(OUTBOX_TABLE).insert(rows.map(outboxObject));
    },

    async insertOutboxAutonomous(row) {
      await knex(OUTBOX_TABLE).insert(outboxObject(row));
    },

    async claimDue({ limit, lockedBy, now }): Promise<OutboxRow[]> {
      return knex.transaction(async (trx) => {
        // Positional bindings (?): now appears twice (filter + SET), see dialect claimSql.qmark.
        const bindings = [now, limit, now, lockedBy];
        const result = (await trx.raw(postgres.claimSql.qmark, bindings)) as unknown as {
          rows: RawOutboxRow[];
        };
        return result.rows.map(mapOutboxRow);
      });
    },

    async applyTransition(id, t: Transition) {
      const { columns, values } = transitionColumns(t);
      const patch = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
      // Idempotency guard: only act on a row still held in_flight.
      await knex(OUTBOX_TABLE).where({ id, status: "in_flight" }).update(patch);
    },

    async reclaimStuck({ reclaimAfterMs, now }): Promise<number> {
      const cutoff = new Date(now.getTime() - reclaimAfterMs);
      const affected = await knex(OUTBOX_TABLE)
        .where("status", "in_flight")
        .andWhere("locked_at", "<", cutoff)
        .update({ status: "pending", locked_at: null, locked_by: null });
      return affected;
    },

    async recordAttempt(a: NewDeliveryAttempt) {
      await knex(ATTEMPTS_TABLE).insert(attemptObject(newId(), a));
    },

    async completeAttempt(a: NewDeliveryAttempt, t: Transition) {
      // One round trip via the shared CTE: INSERT the ledger row + apply the transition.
      const { columns, values } = transitionColumns(t);
      const sql = completeAttemptSql(columns, "qmark");
      const bindings = [...attemptValuesStringified(newId(), a), ...values, a.outboxId];
      await knex.raw(sql, bindings as Knex.RawBinding[]);
    },

    async queryAttempts({ outboxId }): Promise<DeliveryAttempt[]> {
      const rows = (await knex(ATTEMPTS_TABLE)
        .where("outbox_id", outboxId)
        .orderBy("attempt_no")
        .select("*")) as RawAttemptRow[];
      return rows.map(mapAttemptRow);
    },

    async selectForReplay(filter: ReplayFilter): Promise<OutboxRow[]> {
      const q = applyReplayFilter(knex(OUTBOX_TABLE).select("*"), filter);
      const rows = (await q.orderBy("created_at")) as RawOutboxRow[];
      return rows.map(mapOutboxRow);
    },

    async insertReplayCopies(rows): Promise<string[]> {
      await knex.transaction(async (trx) => {
        for (const row of rows) {
          await trx(OUTBOX_TABLE).insert(outboxObject(row));
        }
      });
      return rows.map((r) => r.id);
    },

    ...endpointAndStatsMethods(knex),

    async diagnose() {
      const res = (await knex.raw(postgres.diagnoseSql)) as unknown as {
        rows: Record<string, unknown>[];
      };
      const row = res.rows[0] ?? {};
      return diagnoseResult(existingFromRow(row));
    },

    async migrate() {
      const sql = postgres.ddl();
      await knex.transaction(async (trx) => {
        await trx.raw(sql);
      });
    },
  };
}
