/**
 * Docker-free unit coverage for the `doctor` CLI: config-readiness building (`buildConfigReport`),
 * report formatting (`formatReport` and its db/queue/config branches), database inspection over a
 * faked pool (`inspectDatabase`), and argv dispatch (`main`). The end-to-end path against real
 * Postgres is covered in test/integration/cli-doctor.e2e.test.ts.
 */
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConfigReport, formatReport, inspectDatabase, main } from "../../src/cli";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/**
 * A minimal `pg.Pool` stand-in: it answers each SQL the doctor issues (schema probe, migration
 * ledger, index list, queue/endpoint counts) from canned rows, dispatched on a substring of the
 * query. `migrationsThrow` simulates a database with no migration-tracking table yet.
 */
function fakePool(opts: { fresh?: boolean; migrationsThrow?: boolean } = {}): Pool {
  const present = !opts.fresh;
  const query = (sql: string): Promise<{ rows: unknown[] }> => {
    const rows = (r: unknown[]): Promise<{ rows: unknown[] }> => Promise.resolve({ rows: r });
    if (sql.includes("to_regclass")) {
      return rows([
        {
          webhook_outbox: present,
          webhook_delivery_attempts: present,
          webhook_endpoints: present,
        },
      ]);
    }
    if (sql.includes("commitcourier_migrations")) {
      if (opts.migrationsThrow) return Promise.reject(new Error("relation does not exist"));
      return rows(
        present
          ? [
              { name: "001_init" },
              { name: "002_sink_targetless" },
              { name: "003_list_prune_indexes" },
              { name: "004_endpoint_custom_headers" },
            ]
          : [],
      );
    }
    if (sql.includes("pg_indexes")) {
      return rows(
        present
          ? [
              { indexname: "ix_outbox_due" },
              { indexname: "ix_outbox_inflight" },
              { indexname: "ix_outbox_ep_head" },
            ]
          : [],
      );
    }
    if (sql.includes("min(available_at)")) {
      return rows([{ oldest: new Date(Date.now() - 12 * 60_000) }]);
    }
    if (sql.includes("FROM webhook_endpoints")) {
      return rows([
        { status: "active", count: "4" },
        { status: "disabled", count: "1" },
      ]);
    }
    // The remaining GROUP BY is the outbox queue-status counts.
    return rows([
      { status: "pending", count: "3" },
      { status: "delivered", count: "10" },
      { status: "dead", count: "2" },
    ]);
  };
  return { query } as unknown as Pool;
}

/** A fully-populated, connected DbReport so the text formatter walks every branch. */
function healthyDb() {
  return {
    connected: true,
    error: null,
    coreTablesOk: true,
    missingTables: [] as string[],
    appliedMigrations: ["001_init", "002_sink_targetless"],
    pendingMigrations: [] as string[],
    presentIndexes: ["ix_outbox_due"],
    missingIndexes: [] as string[],
    counts: { pending: 3, delivered: 10, dead: 2 } as Record<string, number>,
    oldestPendingAgeMs: 12 * 60_000,
    endpoints: { active: 4, disabled: 1 },
  };
}

describe("buildConfigReport", () => {
  it("flags logger and cipher as warnings when nothing is configured", () => {
    const report = buildConfigReport(undefined);
    expect(report.loaded).toBe(false);
    expect(report.error).toBeNull();
    expect(report.overridden).toEqual([]);
    const cipher = report.checklist.find((i) => i.key === "cipher");
    const logger = report.checklist.find((i) => i.key === "logger");
    expect(cipher?.status).toBe("warn");
    expect(logger?.status).toBe("warn");
    expect(report.warnings.some((w) => w.startsWith("logger:"))).toBe(true);
    expect(report.warnings.some((w) => w.startsWith("cipher:"))).toBe(true);
  });

  it("marks recommended keys ok/default when the loaded config sets them", () => {
    const report = buildConfigReport({
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      cipher: {},
      endpointCacheTtlMs: 30_000,
      accelerator: {},
      circuitBreaker: { failureThreshold: 5 },
      delivery: { transport: "sink" },
    });
    expect(report.loaded).toBe(true);
    const status = (key: string): string | undefined =>
      report.checklist.find((i) => i.key === key)?.status;
    expect(status("logger")).toBe("ok");
    expect(status("cipher")).toBe("ok");
    expect(status("endpointCacheTtlMs")).toBe("ok");
    expect(status("accelerator")).toBe("ok");
    expect(status("circuitBreaker.failureThreshold")).toBe("ok");
    expect(status("delivery.transport")).toBe("ok");
    // circuitBreaker and delivery differ from the defaults, so both are reported as overridden.
    expect(report.overridden).toContain("circuitBreaker");
    expect(report.overridden).toContain("delivery");
  });

  it("treats an acknowledged plaintext cipher as default, not a warning", () => {
    const report = buildConfigReport({ unsafeAllowPlaintextSecrets: true });
    expect(report.checklist.find((i) => i.key === "cipher")?.status).toBe("default");
    expect(report.warnings.some((w) => w.startsWith("cipher:"))).toBe(false);
  });

  it("returns an error report (not a throw) when the config is invalid", () => {
    const report = buildConfigReport({ mode: "bogus" });
    expect(report.loaded).toBe(false);
    expect(report.error).toMatch(/mode must be/);
    expect(report.checklist).toEqual([]);
  });
});

describe("formatReport", () => {
  it("emits JSON verbatim in --json mode", () => {
    const report = { config: buildConfigReport(undefined), db: null, ok: true };
    const out = formatReport(report, { json: true });
    expect(JSON.parse(out)).toEqual(report);
  });

  it("renders a skipped database when db is null", () => {
    const out = formatReport(
      { config: buildConfigReport(undefined), db: null, ok: true },
      {
        json: false,
      },
    );
    expect(out).toContain("skipped (--skip-db)");
    expect(out).toContain("doctor: ready");
  });

  it("renders a connection failure", () => {
    const db = { ...healthyDb(), connected: false, error: "ECONNREFUSED" };
    const out = formatReport(
      { config: buildConfigReport(undefined), db, ok: false },
      {
        json: false,
      },
    );
    expect(out).toContain("connection failed: ECONNREFUSED");
    expect(out).toContain("doctor: problems found");
  });

  it("renders queue/index/endpoint details for a healthy database", () => {
    const out = formatReport(
      { config: buildConfigReport(undefined), db: healthyDb(), ok: true },
      {
        json: false,
      },
    );
    expect(out).toContain("core tables present");
    expect(out).toContain("dispatch indexes present");
    expect(out).toContain("queue: pending=3 delivered=10 dead=2");
    expect(out).toContain("2 dead rows in the DLQ");
    expect(out).toContain("oldest pending row is 12m old");
    expect(out).toContain("endpoints: active=4 disabled=1");
  });

  it("warns about missing tables, pending migrations and missing indexes", () => {
    const db = {
      ...healthyDb(),
      coreTablesOk: false,
      missingTables: ["webhook_outbox"],
      pendingMigrations: ["001_init"],
      presentIndexes: [] as string[],
      missingIndexes: ["ix_outbox_due"],
      counts: null,
      oldestPendingAgeMs: null,
      endpoints: null,
    };
    const out = formatReport(
      { config: buildConfigReport(undefined), db, ok: false },
      {
        json: false,
      },
    );
    expect(out).toContain("missing: webhook_outbox");
    expect(out).toContain("pending migrations: 001_init");
    expect(out).toContain("missing dispatch indexes: ix_outbox_due");
  });

  it("renders an invalid-config section", () => {
    const out = formatReport(
      { config: buildConfigReport({ mode: "bogus" }), db: null, ok: false },
      { json: false },
    );
    expect(out).toContain("invalid config:");
  });
});

describe("inspectDatabase (faked pool)", () => {
  it("reports a migrated database as healthy with counts, indexes and endpoints", async () => {
    const r = await inspectDatabase(fakePool());
    expect(r.connected).toBe(true);
    expect(r.coreTablesOk).toBe(true);
    expect(r.missingTables).toEqual([]);
    expect(r.pendingMigrations).toEqual([]);
    expect(r.missingIndexes).toEqual([]);
    expect(r.counts).toMatchObject({ pending: 3, delivered: 10, dead: 2 });
    expect(r.oldestPendingAgeMs).toBeGreaterThan(0);
    expect(r.endpoints).toEqual({ active: 4, disabled: 1 });
  });

  it("reports a fresh database as missing tables and skips the queue read", async () => {
    const r = await inspectDatabase(fakePool({ fresh: true, migrationsThrow: true }));
    expect(r.coreTablesOk).toBe(false);
    expect(r.missingTables).toContain("webhook_outbox");
    expect(r.appliedMigrations).toEqual([]); // migration-ledger read failed and was swallowed
    expect(r.pendingMigrations).toContain("001_init");
    expect(r.counts).toBeNull();
    expect(r.endpoints).toBeNull();
  });
});

describe("main (argv dispatch)", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const spyOut = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });

  afterEach(() => {
    stdout.length = 0;
    stderr.length = 0;
    spyOut.mockClear();
    spyErr.mockClear();
  });

  it("prints usage and succeeds for --help", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(stdout.join("")).toContain("commitcourier — transactional outbound webhooks");
  });

  it("prints usage and fails for a bare invocation", async () => {
    expect(await main([])).toBe(1);
  });

  it("rejects an unknown command", async () => {
    expect(await main(["frobnicate"])).toBe(1);
    expect(stderr.join("")).toContain("unknown command: frobnicate");
  });

  it("rejects an unknown option", async () => {
    expect(await main(["doctor", "--nope"])).toBe(1);
    expect(stderr.join("")).toContain("Usage:");
  });

  it("runs doctor against defaults with --skip-db and reports ready", async () => {
    expect(await main(["doctor", "--skip-db"])).toBe(0);
    expect(stdout.join("")).toContain("doctor: ready");
  });

  it("loads a valid --config file with --skip-db", async () => {
    expect(
      await main(["doctor", "--skip-db", "--config", fixture("doctor-config-valid.json")]),
    ).toBe(0);
    expect(stdout.join("")).toContain("config resolves");
  });

  it("exits non-zero for an invalid --config file", async () => {
    const code = await main([
      "doctor",
      "--skip-db",
      "--config",
      fixture("doctor-config-invalid.json"),
    ]);
    expect(code).toBe(1);
    expect(stdout.join("")).toContain("invalid config:");
  });

  it("loads an ESM (.mjs) --config module", async () => {
    expect(await main(["doctor", "--skip-db", "--config", fixture("doctor-config.mjs")])).toBe(0);
    expect(stdout.join("")).toContain("config resolves");
  });

  it("rejects a --config module that does not export an object", async () => {
    await expect(
      main(["doctor", "--skip-db", "--config", fixture("doctor-config-nonobject.mjs")]),
    ).rejects.toThrow(/must export an object/);
  });

  it("reports a connection failure for an unreachable --database-url", async () => {
    const code = await main(["doctor", "--database-url", "postgresql://u@127.0.0.1:1/db"]);
    expect(code).toBe(1);
    expect(stdout.join("")).toContain("connection failed");
  });

  it("errors when no database URL is available and --skip-db is not set", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(await main(["doctor"])).toBe(1);
      expect(stdout.join("")).toContain("no database URL");
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
