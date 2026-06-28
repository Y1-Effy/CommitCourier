/**
 * Integration coverage for the `doctor` CLI's database inspection against real Postgres
 * (testcontainers). Proves it reports a fresh (un-migrated) database as "core tables missing /
 * migration pending" without erroring, and a migrated one as healthy (tables, applied migration,
 * dispatch indexes, queue counts). Requires Docker; skips cleanly without it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { postgresStore } from "../../src/store/pg";
import { inspectDatabase } from "../../src/cli";
import { dockerAvailable, newPgPool, startPostgres, type PgConn } from "./_helpers";

describe.skipIf(!dockerAvailable())("cli doctor — database inspection (integration)", () => {
  let conn: PgConn;
  let stop: () => Promise<void>;
  let pool: Pool;

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
    pool = newPgPool(conn);
  });

  afterAll(async () => {
    await pool.end();
    await stop();
  });

  it("reports a fresh database as missing core tables / migration pending (no error)", async () => {
    const r = await inspectDatabase(pool);
    expect(r.connected).toBe(true);
    expect(r.coreTablesOk).toBe(false);
    expect(r.missingTables.length).toBeGreaterThan(0);
    expect(r.pendingMigrations).toContain("001_init");
    expect(r.counts).toBeNull(); // queue read is skipped while the table is absent
  });

  it("reports a migrated database as healthy with indexes and queue counts", async () => {
    await postgresStore({ pool }).migrate();
    const r = await inspectDatabase(pool);
    expect(r.coreTablesOk).toBe(true);
    expect(r.missingTables).toEqual([]);
    expect(r.appliedMigrations).toContain("001_init");
    expect(r.pendingMigrations).toEqual([]);
    // The dispatch hot-path indexes are present.
    expect(r.missingIndexes).toEqual([]);
    expect(r.presentIndexes).toContain("ix_outbox_due");
    // Queue counts are now readable (all zero on an empty migrated table).
    expect(r.counts).not.toBeNull();
    expect(r.counts?.pending).toBe(0);
    expect(r.endpoints).toEqual({ active: 0, disabled: 0 });
  });
});
