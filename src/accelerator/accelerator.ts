/**
 * Optional low-latency wake seam.
 *
 * The dispatcher runs on adaptive polling alone, so a row enqueued onto a quiet
 * queue waits up to `pollIntervalMs` before delivery starts. An {@link Accelerator} cuts that idle
 * wait short: the signal side fires right after the outbox INSERT, and the listen side hands the
 * dispatcher a wake callback. The accelerator is a pure performance hint — the outbox row stays the
 * single source of truth, so a lost wake (restart, dropped LISTEN connection, best-effort NOTIFY)
 * only delays delivery; the poller always reclaims the row. It changes neither availability nor
 * correctness.
 *
 * This module imports nothing (no driver, no `core`): it is a plain type seam, like the delivery
 * `hooks`/`instrument` seam, so `core` stays import-zero and the main entry never pulls a driver in.
 */

/**
 * The optional wake seam wired via `RelayInit.accelerator`. Every method is best-effort and must
 * never break enqueue or the dispatch loop.
 *
 * @typeParam TTx - the store's transaction handle, so a transactional accelerator (Postgres
 * LISTEN/NOTIFY) can enlist its NOTIFY in the same handle as the enqueue INSERT; a non-transactional
 * one (e.g. BullMQ) simply ignores it.
 */
export interface Accelerator<TTx = unknown> {
  /**
   * Wake listeners about a row enqueued on `trx`. When transactional, enlist the wake in `trx` so it
   * is delivered on COMMIT (never before the row is visible). Returns sync or async.
   */
  signal(trx: TTx): Promise<void> | void;
  /** Wake listeners about a row enqueued outside any business TX (the `enqueueUnsafe` path). */
  signalAutonomous(): Promise<void> | void;
  /**
   * Subscribe a wake callback; resolves to an unsubscribe. The dispatcher calls this on `start()`
   * and the returned unsubscribe on `stop()`. `onWake` only cuts the dispatcher's idle sleep short.
   */
  subscribe(onWake: () => void): Promise<() => void>;
}

/**
 * The listen-side subscription the dispatcher consumes: a factory that registers a wake callback and
 * resolves to an unsubscribe. {@link Accelerator.subscribe} is one such factory; the relay adapts an
 * accelerator into this narrower shape when constructing a dispatcher.
 */
export type WakeSignal = (onWake: () => void) => Promise<() => void>;
