/**
 * Postgres LISTEN/NOTIFY accelerator. `createPgAccelerator({ pool, listen })`.
 *
 * Signal side: a transactional `pg_notify` issued on the enqueue handle, so the wake is delivered on
 * COMMIT and can never precede the row's visibility. Listen side: a dedicated `Client` running
 * `LISTEN`, whose notifications cut the dispatcher's idle sleep short. `pg` is an optional peer
 * dependency, so it is imported for types only and the connections are injected.
 *
 * The accelerator is best-effort: a dropped LISTEN connection or a missed NOTIFY only delays
 * delivery, never loses it — the poller reclaims the row (the outbox stays the source of truth).
 */
import type { Pool, PoolClient, Client, Notification } from "pg";
import type { Logger } from "../core/index";
import type { Accelerator } from "./accelerator";

/** Options for {@link createPgAccelerator}. */
export interface PgAcceleratorOptions {
  /** Pool used to issue the autonomous NOTIFY (`enqueueUnsafe` path). */
  pool: Pool;
  /**
   * Factory for the dedicated LISTEN connection. LISTEN holds a connection for the subscription's
   * lifetime, so it must NOT draw from `pool` (that would exhaust the delivery pool). Typically
   * `() => { const c = new Client(cfg); await c.connect(); return c; }`.
   */
  listen: () => Promise<Client>;
  /** NOTIFY/LISTEN channel. Must be a plain lowercase identifier. Default `"commitcourier_outbox"`. */
  channel?: string;
  /** Logger for best-effort failures. Defaults to no-op. */
  logger?: Logger;
}

const DEFAULT_CHANNEL = "commitcourier_outbox";
/** A safe, unquoted Postgres identifier — LISTEN/UNLISTEN inline the channel (no bind parameter). */
const CHANNEL_RE = /^[a-z_][a-z0-9_]*$/;
/** Postgres truncates identifiers at NAMEDATALEN-1 (63) bytes; the regex limits it to ASCII (1B/char). */
const CHANNEL_MAX_LEN = 63;

const NO_OP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Reconnect backoff bounds for the LISTEN connection. */
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;

/**
 * Build a Postgres LISTEN/NOTIFY {@link Accelerator}. Pass the result to
 * `createRelay({ store, accelerator })`; the relay fires `signal` after each enqueue INSERT and
 * subscribes every dispatcher it creates.
 *
 * @example
 * ```ts
 * import { Pool, Client } from "pg";
 * import { createPgAccelerator } from "commitcourier/accelerator/pg";
 * const pool = new Pool(cfg);
 * const accelerator = createPgAccelerator({
 *   pool,
 *   listen: async () => { const c = new Client(cfg); await c.connect(); return c; },
 * });
 * const relay = await createRelay({ store: postgresStore({ pool }), accelerator });
 * ```
 */
export function createPgAccelerator(opts: PgAcceleratorOptions): Accelerator<PoolClient> {
  const { pool, listen } = opts;
  const channel = opts.channel ?? DEFAULT_CHANNEL;
  const logger = opts.logger ?? NO_OP_LOGGER;
  if (!CHANNEL_RE.test(channel)) {
    throw new Error(
      `createPgAccelerator: channel must match ${String(CHANNEL_RE)}, got "${channel}"`,
    );
  }
  // Fail fast: an over-long channel passes the pattern but would fail at pg_notify runtime, and
  // because signal() rides the enqueue TX that runtime error would roll back the user's business TX.
  if (channel.length > CHANNEL_MAX_LEN) {
    throw new Error(
      `createPgAccelerator: channel must be at most ${String(CHANNEL_MAX_LEN)} bytes, got ${String(channel.length)}`,
    );
  }
  const notifySql = `SELECT pg_notify($1, '')`;

  return {
    signal(client) {
      // Ride the enqueue TX: NOTIFY is delivered on COMMIT, so a listener never wakes before the row
      // is visible. Issued AFTER the INSERT; an error here aborts the TX, keeping enqueue fail-closed.
      return client.query(notifySql, [channel]).then(() => undefined);
    },

    async signalAutonomous() {
      // Non-TX wake for enqueueUnsafe. Best-effort: a failed NOTIFY only costs latency (the poller
      // still picks the row up), so swallow and log rather than propagate.
      try {
        await pool.query(notifySql, [channel]);
      } catch (err) {
        logger.warn("pg accelerator: autonomous NOTIFY failed", { error: String(err) });
      }
    },

    subscribe(onWake) {
      return subscribe({ listen, channel, logger, onWake });
    },
  };
}

/** Internal subscription state: a self-healing LISTEN connection that calls `onWake` on each NOTIFY. */
function subscribe(deps: {
  listen: () => Promise<Client>;
  channel: string;
  logger: Logger;
  onWake: () => void;
}): Promise<() => void> {
  const { listen, channel, logger, onWake } = deps;
  const sub = { stopped: false };
  // Read through a function so control-flow analysis cannot narrow the flag across `await` and the
  // reconnect callbacks (the unsubscribe closure flips it where the analyzer cannot see).
  const stopped = (): boolean => sub.stopped;
  let current: Client | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = RECONNECT_MIN_MS;

  const scheduleReconnect = (): void => {
    if (stopped() || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  };

  const connect = async (): Promise<void> => {
    if (stopped()) return;
    let client: Client;
    try {
      client = await listen();
    } catch (err) {
      logger.warn("pg accelerator: LISTEN connect failed; will retry", { error: String(err) });
      scheduleReconnect();
      return;
    }
    // An unexpected drop loses notifications until we re-LISTEN; reconnect and fire one wake so any
    // rows enqueued during the gap are picked up immediately (self-healing — the poller is the net).
    // The guard makes this a no-op until the client becomes `current` (set only after LISTEN
    // succeeds), so a drop *during* setup is ignored here and handled by the LISTEN catch below.
    const onDrop = (err?: Error): void => {
      if (current !== client) return;
      current = null;
      if (err) logger.warn("pg accelerator: LISTEN connection error", { error: String(err) });
      onWake();
      scheduleReconnect();
    };
    // Attach BEFORE issuing LISTEN: a live pg Client with no "error" listener crashes the process on
    // a connection-level error (Node's default for an unhandled "error" event). The setup window
    // (the LISTEN round trip) must be covered too, not just steady state.
    client.on("error", onDrop);
    client.on("end", () => {
      onDrop();
    });
    try {
      await client.query(`LISTEN ${channel}`);
    } catch (err) {
      logger.warn("pg accelerator: LISTEN failed; will retry", { error: String(err) });
      void client.end().catch(() => {}); // close the opened-but-unusable connection (no leak)
      scheduleReconnect();
      return;
    }
    if (stopped()) {
      void client.end().catch(() => {});
      return;
    }
    current = client;
    backoffMs = RECONNECT_MIN_MS; // healthy: reset backoff.
    // A NOTIFY arriving between LISTEN completing and this handler attaching is missed, but that only
    // costs latency (the poller still picks the row up — the outbox is the source of truth), which is
    // the accelerator's best-effort contract.
    client.on("notification", (msg: Notification) => {
      if (msg.channel === channel) onWake();
    });
  };

  return connect().then(() => () => {
    // Unsubscribe: stop reconnecting and tear down the current LISTEN connection.
    sub.stopped = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const client = current;
    current = null;
    if (client) {
      // Ending the dedicated connection drops its LISTEN on its own; UNLISTEN is issued first as a
      // courtesy. Both are fire-and-forget — there is nothing left to wait for once unsubscribed.
      void client.query(`UNLISTEN ${channel}`).catch(() => {});
      void client.end().catch(() => {});
    }
  });
}
