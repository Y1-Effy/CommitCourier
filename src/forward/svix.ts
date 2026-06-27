/**
 * Official sample sink adapter for Svix (`commitcourier/forward/svix`).
 *
 * Hands each event to `svix.message.create`, forwarding CommitCourier's `idempotencyKey` to Svix's
 * dedup key so an at-least-once redelivery is collapsed on the Svix side. `svix` is an optional peer
 * dependency (like `pg` / `knex` / `@opentelemetry/api`): it is imported as a type only, so importing
 * the main `commitcourier` entry never pulls Svix into scope. The caller constructs and passes the
 * `Svix` client. Wire the returned `Sink` into `createRelay({ delivery: { transport: "sink", sink } })`.
 *
 * CommitCourier bounds each handoff by `delivery.timeoutMs`, but this adapter does not set a Svix-side
 * timeout: configure the `Svix` client's own timeout/retry to bound the upstream call.
 */
import type { Svix } from "svix";
import type { Sink } from "./index";

/** Options for {@link svixSink}: an initialised Svix client and the target application id. */
export interface SvixSinkOptions {
  svix: Svix;
  appId: string;
}

/**
 * Build a {@link Sink} that hands events to Svix, returning the Svix message id for ledger correlation.
 *
 * Experimental — this API may change in a minor release.
 */
export function svixSink(opts: SvixSinkOptions): Sink {
  return {
    async deliver(event) {
      const res = await opts.svix.message.create(
        opts.appId,
        { eventType: event.eventType, payload: event.payload as Record<string, unknown> },
        // Forward CommitCourier's idempotencyKey to Svix's dedup key (fallback to the outbox row id).
        { idempotencyKey: event.idempotencyKey ?? event.id },
      );
      return { providerMessageId: res.id };
    },
  };
}
