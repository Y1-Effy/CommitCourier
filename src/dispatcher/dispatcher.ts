/**
 * Background delivery loop.
 *
 * The loop keeps the p-limit queue continuously filled rather than draining one batch at a time:
 * it claims due rows up to the free capacity, dispatches them without waiting, and claims again as
 * soon as slots free. So a single slow delivery never stalls the others (no batch barrier). Running
 * many loops (same or different processes) stays safe: single delivery is guaranteed by SKIP LOCKED
 * and at-least-once by visibility-timeout reclaim. The loop is fail-open — a delivery or DB error is
 * logged and never stops iteration.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import pLimit, { type LimitFunction } from "p-limit";
import { RelayError } from "../core/index";
import type { OutboxRow, RelayConfig } from "../core/index";
import type { Store } from "../store/store";
import type { WakeSignal } from "../accelerator/accelerator";

export interface DispatcherOptions {
  /** Max concurrent deliveries. Default 8. */
  concurrency?: number;
  /** Idle poll interval in ms when there is no backlog. Default 1000. */
  pollIntervalMs?: number;
  /** Visibility timeout: reclaim in_flight rows older than this. Default 300000 (5 min). */
  reclaimAfterMs?: number;
  /** How often to run the reclaim sweep. Default min(reclaimAfterMs, 30000). */
  reclaimIntervalMs?: number;
  /** Upper bound on rows claimed-but-not-finished at once (in-flight buffer). Default concurrency * 2. */
  batchSize?: number;
  /**
   * Delivery ordering. `"none"` (default) claims globally oldest-first with full concurrency.
   * `"per-endpoint"` opts into per-endpoint FIFO: at most one in-flight delivery per registered
   * endpoint, strictly in arrival order (a failed head row holds the line until it is delivered or
   * dead). Inline (`{ url, secret }`) deliveries are unaffected.
   */
  ordering?: "none" | "per-endpoint";
}

/** Options for a single {@link Dispatcher.runOnce} drain. */
export interface RunOnceOptions {
  /**
   * Sweep stale `in_flight` locks back to `pending` before draining (visibility-timeout reclaim), so
   * rows orphaned by a previous crashed invocation are picked up. Default true.
   */
  reclaim?: boolean;
  /** Upper bound on rows processed in this drain. Default unbounded (drain everything currently due). */
  maxRows?: number;
}

export interface Dispatcher {
  /** Start the loop. Resolves immediately; iteration continues in the background. */
  start(): Promise<void>;
  /** Graceful stop: halt new claims and wait for in-flight deliveries to finish. */
  stop(): Promise<void>;
  isRunning(): boolean;
  /**
   * Drain the queue once and return, instead of running the continuous loop — for serverless/cron
   * deployments that cannot host a long-lived process. Claims due rows in waves (up to `batchSize`,
   * honouring the configured `ordering`), delivers them with the configured `concurrency`, and
   * resolves once the queue is empty (or `maxRows` is reached) and every dispatched delivery has
   * settled. Fail-open like the loop: a claim/delivery error is logged, never thrown. Rejects only if
   * called while the continuous loop is running (use one or the other). Returns the number of rows
   * dispatched this run (regardless of per-row outcome).
   */
  runOnce(options?: RunOnceOptions): Promise<{ processed: number }>;
}

interface ResolvedOptions {
  concurrency: number;
  pollIntervalMs: number;
  reclaimAfterMs: number;
  reclaimIntervalMs: number;
  batchSize: number;
  ordering: "none" | "per-endpoint";
}

function resolveOptions(o: DispatcherOptions = {}): ResolvedOptions {
  const concurrency = o.concurrency ?? 8;
  const reclaimAfterMs = o.reclaimAfterMs ?? 300_000;
  const resolved: ResolvedOptions = {
    concurrency,
    pollIntervalMs: o.pollIntervalMs ?? 1000,
    reclaimAfterMs,
    reclaimIntervalMs: o.reclaimIntervalMs ?? Math.min(reclaimAfterMs, 30_000),
    batchSize: o.batchSize ?? concurrency * 2,
    ordering: o.ordering ?? "none",
  };
  validateOptions(resolved);
  return resolved;
}

/**
 * Fail-fast on misconfiguration. In particular a non-positive batchSize would silently deliver
 * nothing (claimDue with limit 0 always returns []), so reject it loudly rather than stall forever.
 */
function validateOptions(resolved: ResolvedOptions): void {
  if (!(resolved.concurrency >= 1)) {
    fail(`dispatcher concurrency must be >= 1, got ${String(resolved.concurrency)}`);
  }
  if (!(resolved.batchSize >= 1)) {
    fail(`dispatcher batchSize must be >= 1, got ${String(resolved.batchSize)}`);
  }
  if (!(resolved.pollIntervalMs >= 0)) {
    fail(`dispatcher pollIntervalMs must be >= 0, got ${String(resolved.pollIntervalMs)}`);
  }
  if (!(resolved.reclaimAfterMs >= 0)) {
    fail(`dispatcher reclaimAfterMs must be >= 0, got ${String(resolved.reclaimAfterMs)}`);
  }
  if (!(resolved.reclaimIntervalMs >= 0)) {
    fail(`dispatcher reclaimIntervalMs must be >= 0, got ${String(resolved.reclaimIntervalMs)}`);
  }
}

function fail(message: string): never {
  throw new RelayError("CONFIG_INVALID", message);
}

/**
 * At-least-once correctness rests on an unenforced invariant: the visibility timeout
 * (`reclaimAfterMs`) must comfortably exceed the worst-case time a claimed row stays `in_flight`. A
 * row is claimed (and its `locked_at` stamped) up front, but with a claim buffer (`batchSize` above
 * `concurrency`) it can wait in the p-limit queue for up to `ceil(batchSize/concurrency)` delivery
 * waves before its HTTP even starts — so the worst case is `timeoutMs * ceil(batchSize/concurrency)`,
 * not `timeoutMs`. If `reclaimAfterMs` does not exceed that (×1.5 margin), a still-queued row can be
 * reclaimed and double-delivered. Dangerous-but-valid config (like the SSRF warnings in core), so
 * warn rather than fail.
 */
function warnIfReclaimTooTight(opts: ResolvedOptions, config: RelayConfig): void {
  const { timeoutMs } = config.delivery;
  const bufferWaves = Math.ceil(opts.batchSize / opts.concurrency);
  const safeFloor = timeoutMs * 1.5 * bufferWaves;
  if (opts.reclaimAfterMs <= safeFloor) {
    config.logger.warn(
      "dispatcher reclaimAfterMs is not safely above the worst-case in-flight time (delivery.timeoutMs scaled by the claim buffer batchSize/concurrency); an in-flight delivery may be reclaimed and double-delivered",
      {
        reclaimAfterMs: opts.reclaimAfterMs,
        timeoutMs,
        batchSize: opts.batchSize,
        concurrency: opts.concurrency,
      },
    );
  }
}

/** Worker identity for `locked_by`: helps identify stuck locks across instances. */
function makeLockedBy(): string {
  return `${hostname()}:${String(process.pid)}:${randomBytes(4).toString("hex")}`;
}

/** Everything the continuous dispatch loop needs, bundled so it can live at module scope. */
interface LoopCtx {
  store: Store;
  deliver: (row: OutboxRow) => Promise<void>;
  config: RelayConfig;
  opts: ResolvedOptions;
  limit: LimitFunction;
  lockedBy: string;
  active: () => boolean;
  inFlight: Set<Promise<void>>;
  sleep: (ms: number) => Promise<void>;
  /** Wake-aware idle sleep: returns early when an accelerator wake arrives (see createDispatcher). */
  idleSleep: (ms: number) => Promise<void>;
}

/** One-shot visibility-timeout reclaim (fail-open): used by runOnce before draining. */
async function reclaimQuietly(
  store: Store,
  opts: ResolvedOptions,
  config: RelayConfig,
): Promise<void> {
  try {
    await store.reclaimStuck({ reclaimAfterMs: opts.reclaimAfterMs, now: config.clock() });
  } catch (err) {
    config.logger.error("dispatcher reclaim failed", { error: String(err) });
  }
}

/**
 * The continuous dispatch loop: keep the in-flight buffer filled (claim up to free capacity,
 * dispatch without awaiting, claim again as slots free), reclaiming on a throttle. Drains all
 * in-flight deliveries before returning so stop() is graceful. Fail-open throughout.
 */
async function runLoop(ctx: LoopCtx): Promise<void> {
  const { store, deliver, config, opts, limit, lockedBy, active, inFlight, sleep, idleSleep } = ctx;
  const { logger, clock } = config;
  let lastReclaimAt = 0;
  // Adaptive idle backoff: when the queue is empty, start near-immediate and double up to
  // pollIntervalMs, so the first row after an idle period is picked up with low latency without
  // busy-spinning while quiet. Reset to the floor whenever work is found.
  const minIdleMs = Math.min(50, opts.pollIntervalMs);
  let idleMs = minIdleMs;

  const freeCapacity = (): number => opts.batchSize - (limit.activeCount + limit.pendingCount);
  const schedule = (row: OutboxRow): void => {
    // deliver is contracted not to throw; swallow any violation so a rejected promise can never
    // poison `Promise.race`/`allSettled` over inFlight and stop the loop (fail-open).
    const p = limit(() => deliver(row))
      .catch((err: unknown) => {
        logger.error("dispatcher delivery threw", { id: row.id, error: String(err) });
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  };
  const maybeReclaim = async (): Promise<void> => {
    const now = clock();
    if (now.getTime() - lastReclaimAt < opts.reclaimIntervalMs) return;
    lastReclaimAt = now.getTime();
    try {
      await store.reclaimStuck({ reclaimAfterMs: opts.reclaimAfterMs, now });
    } catch (err) {
      logger.error("dispatcher reclaim failed", { error: String(err) });
    }
  };

  while (active()) {
    await maybeReclaim();
    if (!active()) break;
    const capacity = freeCapacity();
    if (capacity <= 0) {
      // Buffer full: wait for any in-flight delivery to finish (inFlight is non-empty here; the
      // sleep is a defensive fallback only), then re-evaluate.
      if (inFlight.size > 0) await Promise.race([...inFlight]);
      else await sleep(opts.pollIntervalMs);
      continue;
    }
    let rows: OutboxRow[];
    try {
      rows = await store.claimDue({
        limit: capacity,
        lockedBy,
        now: clock(),
        ordering: opts.ordering,
      });
    } catch (err) {
      logger.error("dispatcher claim failed", { error: String(err) });
      await sleep(opts.pollIntervalMs);
      continue;
    }
    if (rows.length === 0) {
      // Nothing due: wait the current backoff, then lengthen it up to the poll-interval cap. The
      // wait is wake-aware — an accelerator NOTIFY cuts it short so a freshly enqueued row is picked
      // up at once instead of after the backoff.
      await idleSleep(idleMs);
      idleMs = Math.min(idleMs * 2, opts.pollIntervalMs);
      continue;
    }
    idleMs = minIdleMs; // work found: reset the idle backoff to its floor.
    // deliver never throws; schedule without awaiting and loop to claim more as slots free.
    for (const row of rows) schedule(row);
  }
  await Promise.allSettled([...inFlight]); // graceful drain
}

export function createDispatcher(deps: {
  store: Store;
  deliver: (row: OutboxRow) => Promise<void>;
  config: RelayConfig;
  options?: DispatcherOptions;
  /**
   * Optional accelerator subscription. When present, the dispatcher subscribes on
   * `start()` and unsubscribes on `stop()`; an incoming wake cuts the idle backoff short so a
   * freshly enqueued row is dispatched with low latency. Omitted keeps pure adaptive polling.
   */
  wakeSignal?: WakeSignal;
}): Dispatcher {
  const { store, deliver, config, wakeSignal } = deps;
  const opts = resolveOptions(deps.options);
  warnIfReclaimTooTight(opts, config);
  const limit = pLimit(opts.concurrency);
  const lockedBy = makeLockedBy();

  const state = { running: false };
  // Read through a function so control-flow analysis cannot narrow the flag across `await`
  // (stop() flips it from another closure, which the analyzer cannot see).
  const active = (): boolean => state.running;
  const inFlight = new Set<Promise<void>>();
  let loopPromise: Promise<void> | null = null;
  let sleepAbort: AbortController | null = null;

  /** Interruptible sleep so stop() can cut a poll-interval wait short. */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const ac = new AbortController();
      sleepAbort = ac;
      const timer = setTimeout(() => {
        sleepAbort = null;
        resolve();
      }, ms);
      ac.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          sleepAbort = null;
          resolve();
        },
        { once: true },
      );
    });

  // --- Accelerator wake. `wake()` latches and aborts the active idle sleep so the next iteration
  // claims at once. The latch closes the race where a wake arrives between an empty claim and the
  // start of the next idle sleep: idleSleep consumes the latch synchronously before it waits. stop()
  // also aborts the idle sleep so a graceful stop is not delayed by the backoff.
  let wakePending = false;
  let idleAbort: AbortController | null = null;
  const wake = (): void => {
    wakePending = true;
    idleAbort?.abort();
  };
  const idleSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (wakePending) {
        wakePending = false;
        resolve();
        return;
      }
      const ac = new AbortController();
      idleAbort = ac;
      const finish = (): void => {
        if (idleAbort === ac) idleAbort = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      ac.signal.addEventListener(
        "abort",
        () => {
          wakePending = false;
          finish();
        },
        { once: true },
      );
    });

  let unsubscribe: Promise<() => void> | null = null;

  return {
    start() {
      if (!state.running) {
        state.running = true;
        loopPromise = runLoop({
          store,
          deliver,
          config,
          opts,
          limit,
          lockedBy,
          active,
          inFlight,
          sleep,
          idleSleep,
        });
        if (wakeSignal) {
          // Subscribe in the background; a failed subscription is fail-open (polling still runs).
          unsubscribe = wakeSignal(wake).catch((err: unknown) => {
            config.logger.error("dispatcher wake subscribe failed", { error: String(err) });
            return () => {};
          });
        }
      }
      return Promise.resolve();
    },

    async stop() {
      state.running = false;
      sleepAbort?.abort();
      idleAbort?.abort();
      await loopPromise;
      loopPromise = null;
      if (unsubscribe) {
        const off = await unsubscribe;
        unsubscribe = null;
        try {
          off();
        } catch (err) {
          config.logger.error("dispatcher wake unsubscribe failed", { error: String(err) });
        }
      }
    },

    isRunning() {
      return state.running;
    },

    async runOnce(runOptions) {
      if (state.running) {
        throw new RelayError(
          "CONFIG_INVALID",
          "dispatcher.runOnce cannot run while the continuous loop is active; use start()/stop() or runOnce(), not both",
        );
      }
      const { logger, clock } = config;
      const cap = runOptions?.maxRows ?? Infinity;
      if (runOptions?.reclaim ?? true) await reclaimQuietly(store, opts, config);
      const inFlightRun = new Set<Promise<void>>();
      // deliver never throws; swallow any contract violation so one rejection cannot poison the
      // Promise.race/allSettled below (fail-open, mirrors the continuous loop's schedule()).
      const schedule = (row: OutboxRow): void => {
        const p = limit(() => deliver(row))
          .catch((err: unknown) => {
            logger.error("dispatcher delivery threw", { id: row.id, error: String(err) });
          })
          .finally(() => inFlightRun.delete(p));
        inFlightRun.add(p);
      };
      let processed = 0;
      while (processed < cap) {
        const want = Math.min(opts.batchSize, cap - processed);
        let rows: OutboxRow[];
        try {
          rows = await store.claimDue({
            limit: want,
            lockedBy,
            now: clock(),
            ordering: opts.ordering,
          });
        } catch (err) {
          logger.error("dispatcher claim failed", { error: String(err) });
          break;
        }
        if (rows.length === 0) break; // queue drained
        for (const row of rows) {
          schedule(row);
          processed++;
        }
        // Bound the claim buffer: wait for a slot before claiming the next wave.
        while (inFlightRun.size >= opts.batchSize) await Promise.race([...inFlightRun]);
      }
      await Promise.allSettled([...inFlightRun]); // drain before returning
      return { processed };
    },
  };
}
