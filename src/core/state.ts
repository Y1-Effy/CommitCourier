/**
 * State machine as pure functions (per 01-core section 3, basic design section 7).
 *
 * Each function returns the field delta to persist; the actual DB update is done by the
 * store. Invariants: `delivered` / `dead` / `cancelled` are terminal (never claimed);
 * `observed` is ignored by the dispatcher; only `in_flight` rows with a stale `lockedAt`
 * are reclaimed.
 */
import type { OutboxRow } from "./types";
import type { RetryConfig } from "./types";
import type { Mode, Status } from "./shared";

/** Persisted-field delta produced by a transition. */
export interface Transition {
  status: Status;
  attempts?: number;
  availableAt?: Date;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  lastError?: string | null;
  dispatchedAt?: Date | null;
}

/** Initial state at enqueue. In observe mode it is `observed` and never actually sent. */
export function initialState(
  mode: Mode,
  now: Date,
): Pick<OutboxRow, "status" | "attempts" | "availableAt"> {
  return {
    status: mode === "observe" ? "observed" : "pending",
    attempts: 0,
    availableAt: now,
  };
}

/** claim: `pending` -&gt; `in_flight` (applied by the store together with SKIP LOCKED). */
export function onClaim(now: Date, lockedBy: string): Transition {
  return { status: "in_flight", lockedAt: now, lockedBy };
}

/** Delivery success (2xx): `in_flight` -&gt; `delivered`. */
export function onSuccess(now: Date): Transition {
  return { status: "delivered", dispatchedAt: now, lockedAt: null, lockedBy: null };
}

/**
 * Delivery failure: increments `attempts`. If still below `maxAttempts` the row goes back
 * to `pending` with a backoff delay; otherwise it moves to the dead-letter state `dead`.
 */
// eslint-disable-next-line max-params -- signature fixed by detailed design 01-core section 3
export function onFailure(
  row: Pick<OutboxRow, "attempts">,
  cfg: RetryConfig,
  now: Date,
  errorSummary: string,
  backoffMs: number,
): Transition {
  const attempts = row.attempts + 1;
  if (attempts < cfg.maxAttempts) {
    return {
      status: "pending",
      attempts,
      availableAt: new Date(now.getTime() + backoffMs),
      lastError: errorSummary,
      lockedAt: null,
      lockedBy: null,
    };
  }
  return { status: "dead", attempts, lastError: errorSummary, lockedAt: null, lockedBy: null };
}

/**
 * Permanent delivery failure (e.g. HTTP 410 Gone): `in_flight` -&gt; `dead` immediately, without
 * consuming the remaining retry budget. `attempts` is still incremented so the ledger/last attempt
 * line up. Used when the receiver signals the destination is gone for good.
 */
export function onPermanentFailure(
  row: Pick<OutboxRow, "attempts">,
  errorSummary: string,
): Transition {
  return {
    status: "dead",
    attempts: row.attempts + 1,
    lastError: errorSummary,
    lockedAt: null,
    lockedBy: null,
  };
}

/**
 * Reclaim a stuck row: `in_flight` with a stale `lockedAt` -&gt; `pending` (at-least-once).
 * The store applies this with a conditional UPDATE on `lockedAt`.
 */
export function onReclaim(): Transition {
  return { status: "pending", lockedAt: null, lockedBy: null };
}
