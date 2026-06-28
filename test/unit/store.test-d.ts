import { describe, expectTypeOf, it } from "vitest";
import type { PoolClient } from "pg";
import type { Knex } from "knex";
import { postgresStore } from "../../src/store/pg";
import { knexStore } from "../../src/store/knex";
import type {
  Store,
  NewOutboxRow,
  OutboxEnqueueStore,
  DispatchStore,
  EndpointStore,
  OutboxQueryStore,
  ReplayStore,
  MaintenanceStore,
  SchemaStore,
} from "../../src/store/store";

describe("Store<TTx> public type shape", () => {
  it("postgresStore binds TTx to pg PoolClient", () => {
    expectTypeOf(postgresStore).returns.toEqualTypeOf<Store<PoolClient>>();
    // insertOutbox requires the driver-specific transaction handle as its first argument.
    expectTypeOf<Store<PoolClient>["insertOutbox"]>().parameter(0).toEqualTypeOf<PoolClient>();
    expectTypeOf<Store<PoolClient>["insertOutbox"]>().parameter(1).toEqualTypeOf<NewOutboxRow>();
  });

  it("knexStore binds TTx to Knex.Transaction", () => {
    expectTypeOf(knexStore).returns.toEqualTypeOf<Store<Knex.Transaction>>();
    expectTypeOf<Store<Knex.Transaction>["insertOutbox"]>()
      .parameter(0)
      .toEqualTypeOf<Knex.Transaction>();
  });

  it("dispatch-path methods do not depend on TTx", () => {
    expectTypeOf<Store["claimDue"]>().returns.resolves.toBeArray();
    expectTypeOf<Store["reclaimStuck"]>().returns.resolves.toBeNumber();
  });
});

describe("Store capability roles (interface segregation)", () => {
  it("Store is the composition of every role, so an adapter satisfies all of them", () => {
    // A `Store<PoolClient>` extends each role: the composition is assignable to them all.
    expectTypeOf<Store<PoolClient>>().toExtend<OutboxEnqueueStore<PoolClient>>();
    expectTypeOf<Store<PoolClient>>().toExtend<DispatchStore>();
    expectTypeOf<Store<PoolClient>>().toExtend<EndpointStore>();
    expectTypeOf<Store<PoolClient>>().toExtend<OutboxQueryStore>();
    expectTypeOf<Store<PoolClient>>().toExtend<ReplayStore>();
    expectTypeOf<Store<PoolClient>>().toExtend<MaintenanceStore>();
    expectTypeOf<Store<PoolClient>>().toExtend<SchemaStore>();
  });

  it("only the enqueue role carries the TTx generic; the dispatch role is non-generic", () => {
    expectTypeOf<OutboxEnqueueStore<PoolClient>["insertOutbox"]>()
      .parameter(0)
      .toEqualTypeOf<PoolClient>();
    // Dispatch-path keys live on DispatchStore, not on the enqueue role.
    expectTypeOf<keyof DispatchStore>().toEqualTypeOf<
      "claimDue" | "applyTransition" | "reclaimStuck" | "recordAttempt" | "completeAttempt"
    >();
  });

  it("each role exposes exactly its own methods (no leakage across concerns)", () => {
    expectTypeOf<keyof OutboxEnqueueStore>().toEqualTypeOf<
      "insertOutbox" | "insertOutboxMany" | "insertOutboxAutonomous"
    >();
    expectTypeOf<keyof ReplayStore>().toEqualTypeOf<"selectForReplay" | "insertReplayCopies">();
    expectTypeOf<keyof MaintenanceStore>().toEqualTypeOf<"prune">();
    expectTypeOf<keyof SchemaStore>().toEqualTypeOf<"diagnose" | "migrate">();
  });
});
