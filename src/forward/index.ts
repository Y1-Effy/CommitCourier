/**
 * Generic delivery sink abstraction (`commitcourier/forward`).
 *
 * A `Sink` is a port abstraction (like `Store` or `Accelerator`): the user or a third party implements
 * it to hand each event off to an external webhook-delivery SaaS (Svix, Outpost, Hookdeck, ...) at
 * least once, instead of CommitCourier delivering over HTTP directly. It lives outside `core` (delivery
 * layer) so `core` stays import-zero; it carries no signing/SSRF surface — those are delegated to the
 * SaaS in `sink` mode. Wire an implementation into `createRelay` via `RelayInit.sink` with the delivery
 * transport set to `sink`. The official Svix sample adapter is `commitcourier/forward/svix`.
 *
 * Experimental — this API is exported but not yet covered by the stability guarantee and may change
 * in a minor release.
 */

/**
 * Generic delivery sink: hands one event to an external destination exactly once per attempt.
 *
 * Experimental — this API may change in a minor release.
 */
export interface Sink {
  deliver(event: SinkEvent): Promise<SinkResult>;
}

/** Minimal, secret-free event handed to a sink. Signing / SSRF are not present (delegated). */
export interface SinkEvent {
  /** Outbox row id (also the dedup / trace anchor). */
  id: string;
  eventType: string;
  payload: unknown;
  /** Provided at enqueue time; forwarded to the SaaS dedup key when present. */
  idempotencyKey?: string;
  endpointId?: string | null;
}

/** Outcome of a single handoff, modelled to preserve HTTP's permanent/retryable distinction. */
export interface SinkResult {
  /** Provider id for correlation (e.g. Svix message id); recorded in the ledger when present. */
  providerMessageId?: string;
  /**
   * Optional transport-equivalent status code; mapped onto isSuccess / isPermanentFailure (state).
   * When present, it takes precedence over `retryable`.
   */
  status?: number | null;
  /**
   * Explicit retryability when `status` is absent; `false` sends the row straight to dead. Ignored when
   * `status` is present (status decides). Defaults to true.
   */
  retryable?: boolean;
  /** Secret-free failure summary when the handoff failed; absent means success. */
  error?: string;
}
