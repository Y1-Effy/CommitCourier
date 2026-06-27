# basic-pg example

A minimal end-to-end CommitCourier run with the `pg` adapter: migrate → create a
relay → `enqueue` inside a transaction → dispatch.

## Run it

1. Start a throwaway Postgres:

   ```sh
   docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16
   ```

2. From the repository root, build and link the package once so `commitcourier`
   resolves (the example imports the package by name, not a relative path):

   ```sh
   npm install
   npm run build
   ```

3. Run the example, pointing it at the database (and optionally a real receiver
   such as a https://webhook.site URL):

   ```sh
   DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres \
   WEBHOOK_URL=https://webhook.site/<your-id> \
   node examples/basic-pg/index.mjs
   ```

The script enqueues one `order.created` event and starts the dispatcher; press
`Ctrl+C` for a graceful shutdown. With a real `WEBHOOK_URL` you will see the
signed delivery arrive; without one, delivery fails and the row is retried per
the default policy (visible through the injected console logger).
