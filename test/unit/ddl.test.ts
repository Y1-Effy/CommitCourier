/**
 * Guards the embedded DDL: the schema is imported as a string and bundled at build time (no
 * runtime file I/O), so it must be reachable from both the shared loader and the Postgres dialect.
 * Runs in the Docker-free unit project and exercises the `.sql`-as-string resolution.
 */
import { describe, expect, it } from "vitest";
import { loadInitSql } from "../../src/store/_shared";

describe("embedded DDL", () => {
  it("loadInitSql returns the schema as a non-empty string", () => {
    const sql = loadInitSql();
    expect(typeof sql).toBe("string");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS webhook_outbox");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS webhook_delivery_attempts");
  });
});
