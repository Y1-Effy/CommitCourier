/**
 * Optional OpenTelemetry adapter (`commitcourier/otel`).
 *
 * Maps CommitCourier's fail-open delivery instrumentation seam (`RelayInit.instrument` /
 * `RelayInit.hooks`, see `../delivery/deliver`) onto OpenTelemetry spans and metrics. This module is
 * the ONLY place `@opentelemetry/api` is referenced: it is an optional peer dependency, so importing
 * the main `commitcourier` entry never pulls OTel into scope, and `core` stays import-zero. Wire the
 * returned `{ instrument, hooks }` into `createRelay({ store, instrument, hooks })`.
 *
 * Each delivery attempt becomes one CLIENT span (started before the request, ended on the terminal
 * outcome) carrying secret-free attributes; the same terminal outcome increments a delivery counter
 * and records a duration histogram, classified by `outcome` (delivered | retry | dead). No secret or
 * high-cardinality id is ever used as a metric attribute.
 */
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Span, Tracer, Meter, Counter, Histogram, Attributes } from "@opentelemetry/api";
import type { DeliveryEvent, DeliveryInstrument, DeliveryHooks } from "../delivery/deliver";

/** Options for {@link createOtelInstrumentation}. Both signals are optional and wired independently. */
export interface OtelInstrumentationOptions {
  /** A tracer; when present, every delivery attempt emits one CLIENT span. */
  tracer?: Tracer;
  /** A meter; when present, every terminal outcome updates the delivery counter and duration histogram. */
  meter?: Meter;
  /** Span name for delivery spans. Defaults to `"commitcourier.delivery"`. */
  spanName?: string;
}

/** The instrumentation wiring to pass to `createRelay`. */
export interface OtelInstrumentation {
  /** Trace seam for `RelayInit.instrument`. */
  instrument: DeliveryInstrument;
  /** Metric callbacks for `RelayInit.hooks`. */
  hooks: DeliveryHooks;
}

const DELIVERIES_COUNTER = "commitcourier.deliveries";
const DURATION_HISTOGRAM = "commitcourier.delivery.duration";

/**
 * Split a `DeliveryEvent.host` (`hostname` / `hostname:port` / `[ipv6]` / `[ipv6]:port`) into the
 * OTel `server.address` (hostname, IPv6 brackets stripped) and `server.port` (number). Using the
 * raw `host` for `server.address` would embed the port, which breaks the OTel semantic convention
 * (port belongs in `server.port`). Returns nulls for an absent/unparseable port.
 */
function splitHost(host: string): { address: string; port: number | null } {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) {
      const address = host.slice(1, end);
      const rest = host.slice(end + 1);
      const port = rest.startsWith(":") ? Number(rest.slice(1)) : Number.NaN;
      return { address, port: Number.isInteger(port) ? port : null };
    }
  }
  const i = host.lastIndexOf(":");
  if (i !== -1) {
    const portStr = host.slice(i + 1);
    if (/^\d+$/.test(portStr)) return { address: host.slice(0, i), port: Number(portStr) };
  }
  return { address: host, port: null };
}

/** Set `server.address`/`server.port` on a span from a `DeliveryEvent.host` (no-op when null). */
function setServer(span: Span, host: string | null): void {
  if (host == null) return;
  const { address, port } = splitHost(host);
  span.setAttribute("server.address", address);
  if (port != null) span.setAttribute("server.port", port);
}

/**
 * Build OpenTelemetry instrumentation from a tracer and/or meter. Pass the result to
 * `createRelay({ store, instrument, hooks })`. Omitting both yields no-op wiring (safe to always wire).
 *
 * @example
 * ```ts
 * import { trace, metrics } from "@opentelemetry/api";
 * import { createOtelInstrumentation } from "commitcourier/otel";
 * const { instrument, hooks } = createOtelInstrumentation({
 *   tracer: trace.getTracer("commitcourier"),
 *   meter: metrics.getMeter("commitcourier"),
 * });
 * const relay = await createRelay({ store, instrument, hooks });
 * ```
 */
export function createOtelInstrumentation(
  opts: OtelInstrumentationOptions = {},
): OtelInstrumentation {
  const { tracer, meter, spanName = "commitcourier.delivery" } = opts;

  const counter: Counter | undefined = meter?.createCounter(DELIVERIES_COUNTER, {
    description: "Count of webhook delivery attempt outcomes.",
  });
  const histogram: Histogram | undefined = meter?.createHistogram(DURATION_HISTOGRAM, {
    unit: "ms",
    description: "Wall-clock duration of webhook delivery attempts.",
  });

  const instrument: DeliveryInstrument = (start) => {
    if (!tracer) return undefined;
    const span = tracer.startSpan(spanName, { kind: SpanKind.CLIENT });
    span.setAttribute("webhook.id", start.id);
    span.setAttribute("webhook.event_type", start.eventType);
    span.setAttribute("webhook.attempt", start.attempt);
    if (start.endpointId != null) span.setAttribute("endpoint.id", start.endpointId);
    setServer(span, start.host);
    return (event) => {
      setServer(span, event.host);
      if (event.status != null) span.setAttribute("http.response.status_code", event.status);
      if (event.error != null) {
        span.setAttribute("error.type", event.error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.error });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    };
  };

  /** Record the counter/histogram for a terminal outcome. Keeps attributes low-cardinality (no id). */
  function record(outcome: "delivered" | "retry" | "dead", event: DeliveryEvent): void {
    if (!counter && !histogram) return;
    const attrs: Attributes = { outcome, "webhook.event_type": event.eventType };
    if (event.status != null) attrs["http.response.status_code"] = event.status;
    counter?.add(1, attrs);
    histogram?.record(event.durationMs, attrs);
  }

  const hooks: DeliveryHooks = {
    onDelivered: (event) => {
      record("delivered", event);
    },
    onRetry: (event) => {
      record("retry", event);
    },
    onDead: (event) => {
      record("dead", event);
    },
  };

  return { instrument, hooks };
}
