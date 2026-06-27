// Minimal end-to-end CommitCourier example with the `pg` adapter.
//
// It migrates the schema, creates a relay, enqueues a webhook inside a real
// business transaction (so it commits or rolls back atomically with the order),
// and runs the dispatcher to deliver it. See ./README.md to run it.
//
// Requires a reachable Postgres via DATABASE_URL, e.g.:
//   docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16
//   DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres node index.mjs

import { Pool } from "pg";
import { createRelay, createConsoleLogger } from "commitcourier";
import { postgresStore } from "commitcourier/store/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = postgresStore({ pool });

// 1. Apply idempotent DDL once (safe to run on every boot).
await store.migrate();

// 2. Create the relay. A logger is passed because the dispatch path is fail-open
//    and otherwise swallows delivery problems silently.
const relay = await createRelay({ store, logger: createConsoleLogger() });

// 3. Enqueue inside your own transaction. If the COMMIT never lands, the outbox
//    row rolls back with your business write — no phantom webhook.
const orderId = `order_${Date.now()}`;
const client = await pool.connect();
try {
  await client.query("BEGIN");

  // ... your real business writes go here, on the same `client` ...

  await relay.enqueue(client, {
    eventType: "order.created",
    payload: { orderId, amount: 4200 },
    // Point this at a real receiver (e.g. https://webhook.site) to see delivery.
    endpoint: {
      url: process.env.WEBHOOK_URL ?? "https://example.com/webhooks",
      secret: "whsec_demo",
    },
    idempotencyKey: orderId,
  });

  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK"); // the outbox row rolls back too
  throw err;
} finally {
  client.release();
}

// 4. Run the dispatcher to deliver due rows in the background.
const dispatcher = relay.createDispatcher({ concurrency: 4, pollIntervalMs: 1_000 });
await dispatcher.start();

// Graceful shutdown: drain in-flight deliveries, then close the pool.
const shutdown = async () => {
  await dispatcher.stop();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Enqueued ${orderId}. Dispatcher running — press Ctrl+C to stop.`);
