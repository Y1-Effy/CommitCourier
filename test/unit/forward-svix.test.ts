/**
 * Svix sample sink adapter (08-forward-sink section 9): svixSink calls svix.message.create with the
 * event type/payload and forwards the idempotencyKey (falling back to the row id), returning the Svix
 * message id for ledger correlation. Uses a structural fake client. No Docker, no network.
 */
import { describe, expect, it, vi } from "vitest";
import type { Svix } from "svix";
import { svixSink } from "../../src/forward/svix";

/** Build a fake Svix client recording message.create calls and returning a fixed message id. */
function fakeSvix(): { svix: Svix; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const create = vi.fn((...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve({ id: "msg_out_1" });
  });
  const svix = { message: { create } } as unknown as Svix;
  return { svix, calls };
}

describe("svixSink", () => {
  it("forwards eventType/payload and the idempotencyKey, returning the provider message id", async () => {
    const { svix, calls } = fakeSvix();
    const sink = svixSink({ svix, appId: "app_1" });
    const result = await sink.deliver({
      id: "row-1",
      eventType: "order.created",
      payload: { a: 1 },
      idempotencyKey: "idem-9",
    });
    expect(result).toEqual({ providerMessageId: "msg_out_1" });
    expect(calls[0]).toEqual([
      "app_1",
      { eventType: "order.created", payload: { a: 1 } },
      { idempotencyKey: "idem-9" },
    ]);
  });

  it("falls back to the outbox row id when no idempotencyKey is present", async () => {
    const { svix, calls } = fakeSvix();
    const sink = svixSink({ svix, appId: "app_1" });
    await sink.deliver({ id: "row-2", eventType: "order.created", payload: {} });
    expect((calls[0]?.[2] as { idempotencyKey: string }).idempotencyKey).toBe("row-2");
  });
});
