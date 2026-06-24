/**
 * Background delivery loop (per 04-dispatcher).
 *
 * Each tick reclaims stuck locks, claims due rows with `FOR UPDATE SKIP LOCKED`, and dispatches
 * them concurrently with `p-limit`. Running many loops (same or different processes) stays safe:
 * single delivery is guaranteed by SKIP LOCKED and at-least-once by visibility-timeout reclaim.
 * The loop is fail-open — a delivery or DB error is logged and never stops iteration.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import pLimit from "p-limit";
import { RelayError } from "../core/index";
import type { OutboxRow, RelayConfig } from "../core/index";
import type { Store } from "../store/store";

export interface DispatcherOptions {
  /** Max concurrent deliveries. Default 8. */
  concurrency?: number;
  /** Idle poll interval in ms when there is no backlog. Default 1000. */
  pollIntervalMs?: number;
  /** Visibility timeout: reclaim in_flight rows older than this. Default 300000 (5 min). */
  reclaimAfterMs?: number;
  /** Rows claimed per tick. Default concurrency * 2. */
  batchSize?: number;
}

export interface Dispatcher {
  /** Start the loop. Resolves immediately; iteration continues in the background. */
  start(): Promise<void>;
  /** Graceful stop: halt new ticks and wait for in-flight deliveries to finish. */
  stop(): Promise<void>;
  isRunning(): boolean;
}

interface ResolvedOptions {
  concurrency: number;
  pollIntervalMs: number;
  reclaimAfterMs: number;
  batchSize: number;
}

function resolveOptions(o: DispatcherOptions = {}): ResolvedOptions {
  const concurrency = o.concurrency ?? 8;
  const resolved: ResolvedOptions = {
    concurrency,
    pollIntervalMs: o.pollIntervalMs ?? 1000,
    reclaimAfterMs: o.reclaimAfterMs ?? 300_000,
    batchSize: o.batchSize ?? concurrency * 2,
  };
  // Fail-fast on misconfiguration. In particular batchSize <= 0 would silently deliver nothing
  // (claimDue with limit 0 always returns []), so reject it loudly rather than stall forever.
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
  return resolved;
}

function fail(message: string): never {
  throw new RelayError("CONFIG_INVALID", message);
}

/** Worker identity for `locked_by`: helps identify stuck locks across instances. */
function makeLockedBy(): string {
  return `${hostname()}:${String(process.pid)}:${randomBytes(4).toString("hex")}`;
}

export function createDispatcher(deps: {
  store: Store;
  deliver: (row: OutboxRow) => Promise<void>;
  config: RelayConfig;
  options?: DispatcherOptions;
}): Dispatcher {
  const { store, deliver, config } = deps;
  const { logger, clock } = config;
  const opts = resolveOptions(deps.options);
  const limit = pLimit(opts.concurrency);
  const lockedBy = makeLockedBy();

  const state = { running: false };
  // Read through a function so control-flow analysis cannot narrow the flag across `await`
  // (stop() flips it from another closure, which the analyzer cannot see).
  const active = (): boolean => state.running;
  let loopPromise: Promise<void> | null = null;
  let sleepAbort: AbortController | null = null;

  /** Interruptible sleep so stop() can cut a poll-interval wait short. */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
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
  }

  /** One iteration: reclaim, claim, dispatch. Returns how many rows were claimed. */
  async function tick(): Promise<number> {
    try {
      await store.reclaimStuck({ reclaimAfterMs: opts.reclaimAfterMs, now: clock() });
    } catch (err) {
      logger.error("dispatcher reclaim failed", { error: String(err) });
    }

    let rows: OutboxRow[];
    try {
      rows = await store.claimDue({ limit: opts.batchSize, lockedBy, now: clock() });
    } catch (err) {
      logger.error("dispatcher claim failed", { error: String(err) });
      return 0;
    }

    // deliver never throws, but allSettled keeps one failure from rejecting the batch.
    await Promise.allSettled(rows.map((row) => limit(() => deliver(row))));
    return rows.length;
  }

  async function loop(): Promise<void> {
    while (active()) {
      const claimed = await tick();
      if (!active()) break;
      // Backpressure: a full batch means there may be more backlog, so tick again immediately;
      // otherwise idle for the poll interval.
      if (claimed < opts.batchSize) {
        await sleep(opts.pollIntervalMs);
      }
    }
  }

  return {
    start() {
      if (!state.running) {
        state.running = true;
        loopPromise = loop();
      }
      return Promise.resolve();
    },

    async stop() {
      state.running = false;
      sleepAbort?.abort();
      await loopPromise;
      loopPromise = null;
    },

    isRunning() {
      return state.running;
    },
  };
}
