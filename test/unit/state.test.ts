import { describe, expect, it } from "vitest";
import { initialState, onClaim, onFailure, onReclaim, onSuccess } from "../../src/core/state";
import type { RetryConfig } from "../../src/core/types";

const NOW = new Date("2026-06-24T00:00:00.000Z");
const cfg: RetryConfig = {
  maxAttempts: 3,
  backoff: "exponential",
  baseMs: 1_000,
  capMs: 60_000,
  jitter: 0,
};

describe("state.initialState", () => {
  it("starts pending in active mode", () => {
    expect(initialState("active", NOW)).toEqual({
      status: "pending",
      attempts: 0,
      availableAt: NOW,
    });
  });

  it("starts observed in observe mode (never sent)", () => {
    expect(initialState("observe", NOW).status).toBe("observed");
  });
});

describe("state transitions", () => {
  it("onClaim moves to in_flight and records the lock", () => {
    expect(onClaim(NOW, "host:1:abc")).toEqual({
      status: "in_flight",
      lockedAt: NOW,
      lockedBy: "host:1:abc",
    });
  });

  it("onSuccess moves to delivered and clears the lock", () => {
    expect(onSuccess(NOW)).toEqual({
      status: "delivered",
      dispatchedAt: NOW,
      lockedAt: null,
      lockedBy: null,
    });
  });

  it("onFailure below max returns to pending with backoff applied", () => {
    const t = onFailure({ attempts: 0 }, cfg, NOW, "boom", 5_000);
    expect(t.status).toBe("pending");
    expect(t.attempts).toBe(1);
    expect(t.availableAt).toEqual(new Date(NOW.getTime() + 5_000));
    expect(t.lastError).toBe("boom");
    expect(t.lockedAt).toBeNull();
    expect(t.lockedBy).toBeNull();
  });

  it("onFailure at max moves to dead with no availableAt", () => {
    const t = onFailure({ attempts: 2 }, cfg, NOW, "boom", 5_000);
    expect(t.status).toBe("dead");
    expect(t.attempts).toBe(3);
    expect(t.availableAt).toBeUndefined();
  });

  it("onFailure goes straight to dead on the first failure when maxAttempts is 1", () => {
    const t = onFailure({ attempts: 0 }, { ...cfg, maxAttempts: 1 }, NOW, "boom", 5_000);
    expect(t.status).toBe("dead");
    expect(t.attempts).toBe(1);
    expect(t.availableAt).toBeUndefined();
  });

  it("onReclaim returns a stuck row to pending and clears the lock", () => {
    expect(onReclaim()).toEqual({ status: "pending", lockedAt: null, lockedBy: null });
  });
});
