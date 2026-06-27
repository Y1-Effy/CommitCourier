/**
 * Migration tracking (02-store section 5 / v2 tech-debt): the version table + ordered apply protocol
 * is dialect-agnostic plumbing in `_shared`, so it is exercised here without Docker. The real
 * apply-against-Postgres path is covered by the store integration suite.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MIGRATIONS,
  MIGRATIONS_TABLE,
  migrationScript,
  migrationsTableScript,
  splitStatements,
  applyMigrations,
  type Migration,
} from "../../src/store/_shared";

describe("MIGRATIONS list", () => {
  it("starts with the v1 schema as 001_init", () => {
    expect(MIGRATIONS[0]?.name).toBe("001_init");
    expect(MIGRATIONS[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS webhook_outbox");
  });
});

describe("migrationScript", () => {
  it("takes the advisory lock first, then the DDL, then an idempotent record INSERT", () => {
    const script = migrationScript({ name: "001_init", sql: "CREATE TABLE t (id int);" });
    const stmts = splitStatements(script);
    // Advisory lock must be the first statement so concurrent migrators serialise before any DDL.
    expect(stmts[0]).toMatch(/^SELECT pg_advisory_xact_lock\(\d+\)$/);
    expect(script).toContain("CREATE TABLE t (id int)");
    expect(script).toContain(
      `INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ('001_init') ON CONFLICT (name) DO NOTHING`,
    );
    // The trailing semicolon of the DDL is collapsed so there is no empty statement before the INSERT.
    expect(script).not.toContain(";;");
  });

  it("rejects an unsafe migration name (it is inlined as a literal)", () => {
    expect(() => migrationScript({ name: "evil'); DROP", sql: "SELECT 1" })).toThrow(
      /invalid migration name/,
    );
  });
});

describe("migrationsTableScript", () => {
  it("takes the advisory lock before creating the tracking table", () => {
    const stmts = splitStatements(migrationsTableScript());
    expect(stmts[0]).toMatch(/^SELECT pg_advisory_xact_lock\(\d+\)$/);
    expect(stmts.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE}`))).toBe(
      true,
    );
  });
});

describe("splitStatements", () => {
  it("strips line comments and splits on semicolons, dropping empties", () => {
    expect(splitStatements("-- a comment\nSELECT 1;\n  SELECT 2;\n;")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });
});

describe("applyMigrations", () => {
  const m: Migration = { name: "001_init", sql: "SELECT 1" };

  it("ensures the table, then applies every not-yet-applied migration in order", async () => {
    const order: string[] = [];
    const ensureTable = vi.fn(() => {
      order.push("ensure");
      return Promise.resolve();
    });
    const apply = vi.fn((mig: Migration) => {
      order.push(`apply:${mig.name}`);
      return Promise.resolve();
    });
    await applyMigrations({
      ensureTable,
      appliedNames: () => Promise.resolve(new Set<string>()),
      apply,
    });
    expect(ensureTable).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledTimes(MIGRATIONS.length);
    expect(order[0]).toBe("ensure");
    expect(order).toContain(`apply:${m.name}`);
  });

  it("skips a migration already recorded as applied", async () => {
    const apply = vi.fn(() => Promise.resolve());
    await applyMigrations({
      ensureTable: () => Promise.resolve(),
      appliedNames: () => Promise.resolve(new Set(MIGRATIONS.map((mig) => mig.name))),
      apply,
    });
    expect(apply).not.toHaveBeenCalled();
  });
});
