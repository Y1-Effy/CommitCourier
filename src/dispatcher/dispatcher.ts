/**
 * Background delivery loop (per 04-dispatcher).
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
}

export interface Dispatcher {
  /** Start the loop. Resolves immediately; iteration continues in the background. */
  start(): Promise<void>;
  /** Graceful stop: halt new claims and wait for in-flight deliveries to finish. */
  stop(): Promise<void>;
  isRunning(): boolean;
}

interface ResolvedOptions {
  concurrency: number;
  pollIntervalMs: number;
  reclaimAfterMs: number;
  reclaimIntervalMs: number;
  batchSize: number;
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
  if (!(resolved.reclaimIntervalMs >= 0)) {
    fail(`dispatcher reclaimIntervalMs must be >= 0, got ${String(resolved.reclaimIntervalMs)}`);
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
}

/**
 * The continuous dispatch loop: keep the in-flight buffer filled (claim up to free capacity,
 * dispatch without awaiting, claim again as slots free), reclaiming on a throttle. Drains all
 * in-flight deliveries before returning so stop() is graceful. Fail-open throughout.
 */
async function runLoop(ctx: LoopCtx): Promise<void> {
  const { store, deliver, config, opts, limit, lockedBy, active, inFlight, sleep } = ctx;
  const { logger, clock } = config;
  let lastReclaimAt = 0;

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
      rows = await store.claimDue({ limit: capacity, lockedBy, now: clock() });
    } catch (err) {
      logger.error("dispatcher claim failed", { error: String(err) });
      await sleep(opts.pollIntervalMs);
      continue;
    }
    if (rows.length === 0) {
      await sleep(opts.pollIntervalMs); // nothing due; idle without busy-spinning
      continue;
    }
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
}): Dispatcher {
  const { store, deliver, config } = deps;
  const opts = resolveOptions(deps.options);
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
        });
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
