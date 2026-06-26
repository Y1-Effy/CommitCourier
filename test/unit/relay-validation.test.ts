import { describe, expect, it } from "vitest";
import { createRelay } from "../../src/relay";
import { RelayError } from "../../src/core/errors";
import type { Store } from "../../src/store/store";

// A stub store is enough: createRelay validates endpointCacheTtlMs before it touches the store.
const stubStore = {} as unknown as Store;

describe("createRelay endpointCacheTtlMs validation", () => {
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid endpointCacheTtlMs (%s) with CONFIG_INVALID",
    async (ttl) => {
      const promise = createRelay({ store: stubStore, endpointCacheTtlMs: ttl });
      await expect(promise).rejects.toBeInstanceOf(RelayError);
      await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    },
  );
});
