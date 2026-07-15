/**
 * Per-endpoint custom headers on the delivery path: what reaches the wire vs what reaches the ledger.
 *
 * The two must share a key set (so a failed delivery still shows which headers were sent) while every
 * custom value is redacted in the ledger (the column is secret-bearing by definition). Also locks the
 * precedence defence: a row written straight through a store adapter, bypassing the admin surface's
 * validation, must still not be able to forge or displace a signature header. No Docker (the http
 * client and store are faked).
 */
import { describe, expect, it } from "vitest";
import { deliverOne } from "../../src/delivery/deliver";
import type { DeliverDeps } from "../../src/delivery/deliver";
import { resolveConfig } from "../../src/core/index";
import { REDACTED_HEADER_VALUE } from "../../src/core/headers";
import type { OutboxRow, EndpointRow } from "../../src/core/index";
import type { Store, NewDeliveryAttempt } from "../../src/store/store";

type HttpResult = Awaited<ReturnType<DeliverDeps["http"]["post"]>>;

const ENDPOINT_ID = "22222222-2222-2222-2222-222222222222";

const ok: HttpResult = {
  status: 200,
  bodySnippet: "",
  durationMs: 1,
  error: null,
  retryAfter: null,
};

function endpoint(customHeaders: Record<string, string> | null): EndpointRow {
  return {
    id: ENDPOINT_ID,
    url: "https://example.test/hook",
    secret: "whsec_dGVzdA",
    secretSecondary: null,
    status: "active",
    description: null,
    consecutiveFailures: 0,
    disabledAt: null,
    metadata: null,
    customHeaders,
    createdAt: new Date(0),
  };
}

const registeredRow = (): OutboxRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  eventType: "order.created",
  payload: { a: 1 },
  endpointId: ENDPOINT_ID,
  targetUrl: null,
  secretSnapshot: null,
  status: "in_flight",
  attempts: 0,
  availableAt: new Date(0),
  lockedAt: new Date(0),
  lockedBy: "w",
  idempotencyKey: null,
  lastError: null,
  createdAt: new Date(0),
  dispatchedAt: null,
});

const inlineRow = (): OutboxRow => ({
  ...registeredRow(),
  endpointId: null,
  targetUrl: "https://inline.test/hook",
  secretSnapshot: "whsec_aW5saW5l",
});

interface Captured {
  wire: Record<string, string>[];
  ledger: Record<string, string>[];
}

/** Fake store + http that record the headers each side saw for one delivery. */
function harness(ep: EndpointRow | null): { deps: DeliverDeps; captured: Captured } {
  const captured: Captured = { wire: [], ledger: [] };
  const store = {
    findEndpoint: () => Promise.resolve(ep),
    completeAttempt: (attempt: NewDeliveryAttempt) => {
      captured.ledger.push(attempt.requestHeaders);
      return Promise.resolve({ transitionApplied: true });
    },
    noteEndpointSuccess: () => Promise.resolve(),
    noteEndpointFailure: () => Promise.resolve(),
    disableEndpoint: () => Promise.resolve(),
  } as unknown as Store;
  const deps: DeliverDeps = {
    store,
    http: {
      post: (opts: { headers: Record<string, string> }) => {
        captured.wire.push(opts.headers);
        return Promise.resolve(ok);
      },
    },
    config: resolveConfig({}),
    clock: () => new Date(0),
  };
  return { deps, captured };
}

describe("custom headers on the wire", () => {
  it("sends the endpoint's custom headers alongside the signature headers", async () => {
    const { deps, captured } = harness(endpoint({ authorization: "Bearer real-token" }));
    await deliverOne(registeredRow(), deps);
    expect(captured.wire[0]).toMatchObject({
      authorization: "Bearer real-token",
      "content-type": "application/json",
    });
    expect(captured.wire[0]?.["webhook-signature"]).toMatch(/^v1,/);
  });

  it("sends nothing extra for an endpoint with no custom headers", async () => {
    const { deps, captured } = harness(endpoint(null));
    await deliverOne(registeredRow(), deps);
    expect(Object.keys(captured.wire[0] ?? {}).sort()).toEqual([
      "content-type",
      "webhook-id",
      "webhook-signature",
      "webhook-timestamp",
    ]);
  });

  it("sends no custom headers for an inline target (there is no endpoint to carry them)", async () => {
    const { deps, captured } = harness(null);
    await deliverOne(inlineRow(), deps);
    expect(captured.wire[0]).not.toHaveProperty("authorization");
    expect(captured.wire[0]?.["webhook-signature"]).toMatch(/^v1,/);
  });
});

describe("custom headers in the ledger", () => {
  it("redacts every custom value but keeps the name", async () => {
    const { deps, captured } = harness(
      endpoint({ authorization: "Bearer real-token", "x-api-key": "sk-live-123" }),
    );
    await deliverOne(registeredRow(), deps);
    expect(captured.ledger[0]).toMatchObject({
      authorization: REDACTED_HEADER_VALUE,
      "x-api-key": REDACTED_HEADER_VALUE,
    });
  });

  it("never lets a credential reach the ledger", async () => {
    const { deps, captured } = harness(endpoint({ authorization: "Bearer real-token" }));
    await deliverOne(registeredRow(), deps);
    expect(JSON.stringify(captured.ledger[0])).not.toContain("real-token");
  });

  it("records the same key set as the wire, so a failed delivery stays debuggable", async () => {
    const { deps, captured } = harness(endpoint({ authorization: "Bearer real-token" }));
    await deliverOne(registeredRow(), deps);
    expect(Object.keys(captured.ledger[0] ?? {}).sort()).toEqual(
      Object.keys(captured.wire[0] ?? {}).sort(),
    );
  });

  it("leaves the library's own headers unredacted", async () => {
    const { deps, captured } = harness(endpoint({ authorization: "Bearer real-token" }));
    const row = { ...registeredRow(), idempotencyKey: "idem-1" };
    await deliverOne(row, deps);
    const wire = captured.wire[0] ?? {};
    const ledger = captured.ledger[0] ?? {};
    for (const name of [
      "webhook-id",
      "webhook-timestamp",
      "webhook-signature",
      "content-type",
      "idempotency-key",
    ]) {
      expect(ledger[name]).toBe(wire[name]);
      expect(ledger[name]).not.toBe(REDACTED_HEADER_VALUE);
    }
  });
});

describe("precedence defence for rows that bypassed validation", () => {
  it("cannot forge or displace a signature header, even spelled in another case", async () => {
    // Reachable: the store adapters are public API, so an endpoint row can be written without going
    // through registerEndpoint's validation. Left unfiltered, `Webhook-Signature` would arrive on the
    // wire as a *second* `webhook-signature` once undici lowercases it.
    const { deps, captured } = harness(
      endpoint({
        "Webhook-Signature": "v1,forged",
        "webhook-id": "forged-id",
        "Content-Type": "text/plain",
      }),
    );
    await deliverOne(registeredRow(), deps);
    const wire = captured.wire[0] ?? {};
    expect(wire["webhook-signature"]).toMatch(/^v1,/);
    expect(wire["webhook-signature"]).not.toBe("v1,forged");
    expect(wire["webhook-id"]).toBe("11111111-1111-1111-1111-111111111111");
    expect(wire["content-type"]).toBe("application/json");
    expect(wire).not.toHaveProperty("Webhook-Signature");
    expect(wire).not.toHaveProperty("Content-Type");
  });

  it("drops a value with a CRLF rather than sending it", async () => {
    const { deps, captured } = harness(endpoint({ "x-evil": "v\r\nX-Injected: yes" }));
    await deliverOne(registeredRow(), deps);
    expect(captured.wire[0]).not.toHaveProperty("x-evil");
  });
});
