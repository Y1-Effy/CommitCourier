import { describe, expectTypeOf, it } from "vitest";
import {
  backoffMs,
  evaluateIp,
  initialState,
  matchHostList,
  resolveConfig,
  sign,
} from "../../src/core/index";
import type {
  DeepPartial,
  RelayConfig,
  SignatureHeaders,
  SsrfDecision,
  Transition,
} from "../../src/core/index";

describe("core public types", () => {
  it("sign is async and returns the three Standard Webhooks headers", () => {
    expectTypeOf(sign).returns.toEqualTypeOf<Promise<SignatureHeaders>>();
    expectTypeOf<keyof SignatureHeaders>().toEqualTypeOf<
      "webhook-id" | "webhook-timestamp" | "webhook-signature"
    >();
  });

  it("backoffMs returns a number", () => {
    expectTypeOf(backoffMs).returns.toBeNumber();
  });

  it("resolveConfig accepts a DeepPartial and returns a fully-resolved RelayConfig", () => {
    expectTypeOf(resolveConfig).parameter(0).toEqualTypeOf<DeepPartial<RelayConfig>>();
    expectTypeOf(resolveConfig).returns.toEqualTypeOf<RelayConfig>();
    // clock/logger are required on the resolved config.
    expectTypeOf<RelayConfig["clock"]>().toEqualTypeOf<() => Date>();
  });

  it("evaluateIp returns a discriminated SsrfDecision", () => {
    expectTypeOf(evaluateIp).returns.toEqualTypeOf<SsrfDecision>();
    expectTypeOf(matchHostList).returns.toBeBoolean();
  });

  it("state transitions return the expected shapes", () => {
    expectTypeOf(initialState).returns.toHaveProperty("status");
    expectTypeOf<Transition["status"]>().not.toBeNever();
  });
});
