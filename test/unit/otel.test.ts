/**
 * The optional OpenTelemetry adapter (`commitcourier/otel`): maps the delivery seam onto a span per
 * attempt (secret-free attributes, OK/ERROR status, ended once) and onto an outcome-classified
 * counter + duration histogram. Driven with fake tracer/meter doubles; no real OTel SDK needed.
 */
import { describe, expect, it, vi } from "vitest";
import { createOtelInstrumentation } from "../../src/otel/index";
import type { DeliveryEvent, DeliveryStart } from "../../src/delivery/deliver";

const start: DeliveryStart = {
  id: "id-1",
  eventType: "order.created",
  attempt: 1,
  endpointId: "ep-1",
  host: "example.test",
};

const deliveredEvent: DeliveryEvent = {
  id: "id-1",
  eventType: "order.created",
  attempt: 1,
  endpointId: "ep-1",
  host: "example.test",
  status: 200,
  error: null,
  durationMs: 12,
};

const failedEvent: DeliveryEvent = {
  ...deliveredEvent,
  status: 500,
  error: "HTTP 500",
  durationMs: 9,
};

/** A fake span that records attribute/status/end calls. */
function fakeSpan() {
  const attrs: Record<string, unknown> = {};
  const status: { code?: number; message?: string } = {};
  let ended = 0;
  const span = {
    setAttribute(k: string, v: unknown) {
      attrs[k] = v;
      return span;
    },
    setStatus(s: { code: number; message?: string }) {
      status.code = s.code;
      status.message = s.message;
      return span;
    },
    end() {
      ended++;
    },
  };
  return { span, attrs, status, ended: () => ended };
}

describe("createOtelInstrumentation spans", () => {
  it("starts a CLIENT span with secret-free start attributes and ends it once with OK on success", () => {
    const s = fakeSpan();
    const startSpan = vi.fn(() => s.span);
    const tracer = { startSpan } as never;
    const { instrument } = createOtelInstrumentation({ tracer });

    const finish = instrument(start);
    expect(startSpan).toHaveBeenCalledTimes(1);
    expect(s.attrs["webhook.id"]).toBe("id-1");
    expect(s.attrs["webhook.event_type"]).toBe("order.created");
    expect(s.attrs["endpoint.id"]).toBe("ep-1");
    expect(s.attrs["server.address"]).toBe("example.test");

    finish?.(deliveredEvent);
    expect(s.attrs["http.response.status_code"]).toBe(200);
    expect(s.status.code).toBe(1); // SpanStatusCode.OK
    expect(s.ended()).toBe(1);
  });

  it("splits host:port into server.address (hostname) + server.port, never embedding the port", () => {
    const s = fakeSpan();
    const tracer = { startSpan: () => s.span } as never;
    const { instrument } = createOtelInstrumentation({ tracer });
    instrument({ ...start, host: "example.test:8443" })?.({
      ...deliveredEvent,
      host: "example.test:8443",
    });
    expect(s.attrs["server.address"]).toBe("example.test"); // no port embedded
    expect(s.attrs["server.port"]).toBe(8443);
  });

  it("strips IPv6 brackets for server.address and extracts the port", () => {
    const s = fakeSpan();
    const tracer = { startSpan: () => s.span } as never;
    const { instrument } = createOtelInstrumentation({ tracer });
    instrument({ ...start, host: "[::1]:9000" })?.({ ...deliveredEvent, host: "[::1]:9000" });
    expect(s.attrs["server.address"]).toBe("::1");
    expect(s.attrs["server.port"]).toBe(9000);
  });

  it("omits server.port when the host has no port", () => {
    const s = fakeSpan();
    const tracer = { startSpan: () => s.span } as never;
    const { instrument } = createOtelInstrumentation({ tracer });
    instrument({ ...start, host: "example.test" })?.({ ...deliveredEvent, host: "example.test" });
    expect(s.attrs["server.address"]).toBe("example.test");
    expect(s.attrs).not.toHaveProperty("server.port");
  });

  it("marks the span ERROR with the secret-free summary on failure", () => {
    const s = fakeSpan();
    const tracer = { startSpan: () => s.span } as never;
    const { instrument } = createOtelInstrumentation({ tracer });
    instrument(start)?.(failedEvent);
    expect(s.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(s.attrs["error.type"]).toBe("HTTP 500");
    expect(s.ended()).toBe(1);
  });

  it("is a no-op instrument when no tracer is supplied", () => {
    const { instrument } = createOtelInstrumentation({});
    expect(instrument(start)).toBeUndefined();
  });
});

describe("createOtelInstrumentation metrics", () => {
  function fakeMeter() {
    const counter = { add: vi.fn() };
    const histogram = { record: vi.fn() };
    const meter = {
      createCounter: vi.fn(() => counter),
      createHistogram: vi.fn(() => histogram),
    } as never;
    return { meter, counter, histogram };
  }

  it("records the counter and duration histogram with an outcome label, never the row id", () => {
    const m = fakeMeter();
    const { hooks } = createOtelInstrumentation({ meter: m.meter });

    void hooks.onDelivered?.(deliveredEvent);
    expect(m.counter.add).toHaveBeenCalledWith(1, {
      outcome: "delivered",
      "webhook.event_type": "order.created",
      "http.response.status_code": 200,
    });
    expect(m.histogram.record).toHaveBeenCalledWith(
      12,
      expect.objectContaining({ outcome: "delivered" }),
    );

    void hooks.onRetry?.(failedEvent);
    expect(m.counter.add).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ outcome: "retry" }),
    );

    void hooks.onDead?.(failedEvent);
    expect(m.counter.add).toHaveBeenLastCalledWith(1, expect.objectContaining({ outcome: "dead" }));

    // The high-cardinality id is never used as a metric attribute.
    for (const call of m.counter.add.mock.calls) {
      expect(call[1]).not.toHaveProperty("webhook.id");
    }
  });
});
