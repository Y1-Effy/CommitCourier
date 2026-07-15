/**
 * Concurrent migration (v2 hardening): N replicas calling migrate() at once on a fresh schema must
 * all succeed, not crash on a non-concurrency-safe CREATE IF NOT EXISTS (Postgres can raise "tuple
 * concurrently updated", a pg_type unique violation, or a deadlock). The advisory lock serialises
 * them. Requires Docker; skips cleanly without one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresStore } from "../../src/store/pg";
import { MIGRATIONS } from "../../src/store/_shared";
import { dockerAvailable, newPgPool, startPostgres, type PgConn } from "./_helpers";

describe.skipIf(!dockerAvailable())("concurrent migrate (integration)", () => {
  let stop: () => Promise<void>;
  let conn: PgConn;

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
  });

  afterAll(async () => {
    await stop();
  });

  it("runs many migrate() calls at once on a fresh DB without error", async () => {
    // Separate pools so each migrate() races on its own connection(s), as distinct replicas would.
    const pools = Array.from({ length: 8 }, () => newPgPool(conn));
    try {
      await Promise.all(pools.map((pool) => postgresStore({ pool }).migrate()));

      const probe = pools[0]!;
      // The schema exists exactly once and the tracking row is recorded exactly once.
      const migs = await probe.query("SELECT name FROM commitcourier_migrations");
      // Recorded once each, in any order (the SELECT is unordered); sort for a stable comparison.
      // Derived from MIGRATIONS, the single source of truth, so adding a migration does not require
      // touching this assertion — what is under test is "every one applied, exactly once", not the
      // specific list.
      expect(migs.rows.map((r: { name: string }) => r.name).sort()).toEqual(
        MIGRATIONS.map((m) => m.name).sort(),
      );
      const diag = await postgresStore({ pool: probe }).diagnose();
      expect(diag.ok).toBe(true);
      expect(diag.missingTables).toEqual([]);

      // A second concurrent wave (now an all-applied no-op) must also be clean.
      await Promise.all(pools.map((pool) => postgresStore({ pool }).migrate()));
      const after = await probe.query("SELECT count(*)::int AS n FROM commitcourier_migrations");
      expect((after.rows[0] as { n: number }).n).toBe(MIGRATIONS.length);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });
});
