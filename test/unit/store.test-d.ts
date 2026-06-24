import { describe, expectTypeOf, it } from "vitest";
import type { PoolClient } from "pg";
import type { Knex } from "knex";
import { postgresStore } from "../../src/store/pg";
import { knexStore } from "../../src/store/knex";
import type { Store, NewOutboxRow } from "../../src/store/store";

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
