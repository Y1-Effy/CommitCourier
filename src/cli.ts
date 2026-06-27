/**
 * `commitcourier` CLI (developer convenience). Currently one command:
 *
 *   `commitcourier doctor [--config <file>] [--database-url <url>] [--skip-db] [--json]`
 *
 * `doctor` is a readiness check: it inspects the database (schema/migrations/indexes/queue health)
 * and surfaces configuration readiness — which settings are at their defaults, which recommended-
 * but-optional ones are unset (and why that matters), and any risky settings. It is meant to be run
 * locally or in CI (non-zero exit when the core tables are missing or the config is invalid).
 *
 * The CLI reuses the library's own internals (no new public API): `resolveConfig` for effective
 * config + warnings, `postgresStore` for `diagnose`/`stats`, and the shared schema constants. `pg` is
 * an optional peer, imported at runtime only for the database checks, so the config checks work
 * without it.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { resolveConfig, RelayError } from "./core/index";
import type { Logger, RelayConfig } from "./core/index";
import { postgresStore } from "./store/pg";
import {
  OUTBOX_TABLE,
  ENDPOINTS_TABLE,
  MIGRATIONS,
  SELECT_APPLIED_MIGRATIONS_SQL,
} from "./store/_shared";

const USAGE = `commitcourier — transactional outbound webhooks

Usage:
  commitcourier doctor [options]      Check database + configuration readiness

Options:
  --config <file>     Inspect a config file (.json/.mjs/.cjs/.js default-exporting a partial config)
  --database-url <url>  Postgres URL (else $DATABASE_URL); the database checks need the 'pg' peer dep
  --skip-db           Skip the database checks (config readiness only)
  --json              Machine-readable JSON output
  --help              Show this help

Exit code is non-zero when the core tables are missing or the config is invalid (CI-friendly).
`;

// --- Report shapes -------------------------------------------------------------------------------

interface ConfigItem {
  key: string;
  status: "ok" | "default" | "warn";
  detail: string;
}
interface ConfigReport {
  /** True when a config file was loaded and resolved without error. */
  loaded: boolean;
  /** Set when the config file failed to resolve (invalid config). */
  error: string | null;
  /** Fields overridden away from the defaults. */
  overridden: string[];
  /** Risk/readiness warnings (from resolveConfig and the recommended-but-unset checklist). */
  warnings: string[];
  /** The recommended-but-optional checklist (each present/unset with rationale). */
  checklist: ConfigItem[];
}
interface DbReport {
  connected: boolean;
  error: string | null;
  coreTablesOk: boolean;
  missingTables: string[];
  appliedMigrations: string[];
  pendingMigrations: string[];
  presentIndexes: string[];
  missingIndexes: string[];
  counts: Record<string, number> | null;
  oldestPendingAgeMs: number | null;
  endpoints: { active: number; disabled: number } | null;
}
interface DoctorReport {
  config: ConfigReport;
  db: DbReport | null;
  ok: boolean;
}

/** Partial dispatch-index set we expect the migration to create; checked for presence. */
const EXPECTED_INDEXES = ["ix_outbox_due", "ix_outbox_inflight", "ix_outbox_ep_head"] as const;

// --- Config readiness ----------------------------------------------------------------------------

/** A logger that captures warn() messages so resolveConfig's risk warnings can be reported as data. */
function capturingLogger(sink: string[]): Logger {
  return { debug() {}, info() {}, warn: (msg) => void sink.push(msg), error() {} };
}

/** Pick the config keys resolveConfig understands from a loosely-typed loaded object. */
function pickConfigKeys(loaded: Record<string, unknown>): Record<string, unknown> {
  const keys = ["mode", "signing", "retry", "delivery", "ssrf", "circuitBreaker", "clock"] as const;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (loaded[k] !== undefined) out[k] = loaded[k];
  return out;
}

/** The recommended-but-optional checklist, derived from which keys the loaded config sets. */
function readinessChecklist(loaded: Record<string, unknown>, effective: RelayConfig): ConfigItem[] {
  const has = (k: string): boolean => loaded[k] != null;
  return [
    {
      key: "logger",
      status: has("logger") ? "ok" : "warn",
      detail: has("logger")
        ? "set"
        : "unset — the default logger is a no-op, so delivery/claim errors are SILENT in production",
    },
    {
      key: "cipher",
      status: has("cipher") ? "ok" : "default",
      detail: has("cipher")
        ? "set — signing secrets encrypted at rest"
        : "unset — signing secrets are stored as plaintext (at-rest encryption is the DB's job)",
    },
    {
      key: "circuitBreaker.failureThreshold",
      status: effective.circuitBreaker.failureThreshold > 0 ? "ok" : "default",
      detail:
        effective.circuitBreaker.failureThreshold > 0
          ? `enabled (${String(effective.circuitBreaker.failureThreshold)})`
          : "0 — failing endpoints are never auto-disabled",
    },
    {
      key: "endpointCacheTtlMs",
      status: has("endpointCacheTtlMs") ? "ok" : "default",
      detail: has("endpointCacheTtlMs")
        ? "set — registered-endpoint lookups cached"
        : "unset — every registered-endpoint delivery does a findEndpoint round trip",
    },
    {
      key: "accelerator",
      status: has("accelerator") ? "ok" : "default",
      detail: has("accelerator")
        ? "set — low-latency LISTEN/NOTIFY wake"
        : "unset — delivery latency is bounded by pollIntervalMs (polling only)",
    },
  ];
}

/** Compare effective config to the defaults and list the top-level fields that were overridden. */
function overriddenFields(effective: RelayConfig, defaults: RelayConfig): string[] {
  const out: string[] = [];
  const cmp = (label: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(label);
  };
  cmp("mode", effective.mode, defaults.mode);
  cmp("retry", effective.retry, defaults.retry);
  cmp("delivery", effective.delivery, defaults.delivery);
  cmp("ssrf", effective.ssrf, defaults.ssrf);
  cmp("circuitBreaker", effective.circuitBreaker, defaults.circuitBreaker);
  return out;
}

/** Build the config-readiness report from an optional loaded config object. */
export function buildConfigReport(loaded: Record<string, unknown> | undefined): ConfigReport {
  const warnings: string[] = [];
  const defaults = resolveConfig({});
  let effective: RelayConfig;
  try {
    effective = resolveConfig({
      ...pickConfigKeys(loaded ?? {}),
      logger: capturingLogger(warnings),
    });
  } catch (err) {
    const message = err instanceof RelayError ? err.message : String(err);
    return { loaded: false, error: message, overridden: [], warnings, checklist: [] };
  }
  const checklist = readinessChecklist(loaded ?? {}, effective);
  for (const item of checklist)
    if (item.status === "warn") warnings.push(`${item.key}: ${item.detail}`);
  return {
    loaded: loaded !== undefined,
    error: null,
    overridden: overriddenFields(effective, defaults),
    warnings,
    checklist,
  };
}

// --- Config file loading -------------------------------------------------------------------------

/** Load a partial config from a file (JSON or an ESM/CJS module's default export). */
async function loadConfigFile(path: string): Promise<Record<string, unknown>> {
  if (path.endsWith(".json")) {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  }
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  const value: unknown = mod.default ?? mod;
  if (value === null || typeof value !== "object") {
    throw new Error(`config file ${path} must export an object (default export)`);
  }
  return value as Record<string, unknown>;
}

// --- Database inspection -------------------------------------------------------------------------

/**
 * Inspect schema, migrations, indexes, queue health and endpoints over an open pool. Resilient to a
 * fresh (un-migrated) database: the queue/endpoint reads are guarded on table presence so doctor
 * reports "tables missing, run migrate()" instead of erroring out.
 */
export async function inspectDatabase(pool: Pool): Promise<DbReport> {
  const store = postgresStore({ pool });
  const diag = await store.diagnose();
  const applied = await readApplied(pool);
  const pending = MIGRATIONS.map((m) => m.name).filter((n) => !applied.includes(n));
  const present = await readIndexes(pool);
  let counts: Record<string, number> | null = null;
  let oldestPendingAgeMs: number | null = null;
  if (!diag.missingTables.includes(OUTBOX_TABLE)) {
    const stats = await store.stats();
    counts = stats.counts;
    oldestPendingAgeMs = stats.oldestPendingAt
      ? Date.now() - stats.oldestPendingAt.getTime()
      : null;
  }
  return {
    connected: true,
    error: null,
    coreTablesOk: diag.ok,
    missingTables: diag.missingTables,
    appliedMigrations: applied,
    pendingMigrations: pending,
    presentIndexes: EXPECTED_INDEXES.filter((i) => present.has(i)),
    missingIndexes: EXPECTED_INDEXES.filter((i) => !present.has(i)),
    counts,
    oldestPendingAgeMs,
    endpoints: diag.missingTables.includes(ENDPOINTS_TABLE) ? null : await endpointCounts(pool),
  };
}

/** Applied migration names; empty when the tracking table does not exist yet. */
async function readApplied(pool: Pool): Promise<string[]> {
  try {
    const res = await pool.query(SELECT_APPLIED_MIGRATIONS_SQL);
    return (res.rows as { name: string }[]).map((r) => r.name);
  } catch {
    return [];
  }
}

/** Index names present on the outbox table. */
async function readIndexes(pool: Pool): Promise<Set<string>> {
  const res = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = $1", [
    OUTBOX_TABLE,
  ]);
  return new Set((res.rows as { indexname: string }[]).map((r) => r.indexname));
}

/** Active/disabled registered-endpoint counts. */
async function endpointCounts(pool: Pool): Promise<{ active: number; disabled: number }> {
  const res = await pool.query(
    `SELECT status, count(*) AS count FROM ${ENDPOINTS_TABLE} GROUP BY status`,
  );
  const rows = res.rows as { status: string; count: string }[];
  const get = (s: string): number => Number(rows.find((r) => r.status === s)?.count ?? 0);
  return { active: get("active"), disabled: get("disabled") };
}

/** Open a pool from a URL and inspect it, always closing the pool. Captures connection errors. */
async function inspectViaUrl(url: string): Promise<DbReport> {
  let pool: Pool;
  try {
    // `pg` is an optional peer, imported only here for the database checks.
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url });
  } catch {
    return dbError(
      "the database checks need the 'pg' peer dependency (npm i pg), or use --skip-db",
    );
  }
  try {
    return await inspectDatabase(pool);
  } catch (err) {
    return dbError(err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end().catch(() => {});
  }
}

function dbError(message: string): DbReport {
  return {
    connected: false,
    error: message,
    coreTablesOk: false,
    missingTables: [],
    appliedMigrations: [],
    pendingMigrations: [],
    presentIndexes: [],
    missingIndexes: [],
    counts: null,
    oldestPendingAgeMs: null,
    endpoints: null,
  };
}

// --- Formatting ----------------------------------------------------------------------------------

const MARK = { ok: "[ ok ]", warn: "[warn]", bad: "[ !! ]", info: "[info]" } as const;

/** Whether the report is a pass (used for the exit code). */
function isOk(report: DoctorReport): boolean {
  if (report.config.error) return false;
  if (report.db && (!report.db.connected || !report.db.coreTablesOk)) return false;
  return true;
}

/** Render the report as human-readable text or JSON. The report is secret-free by construction (it
 * holds diagnostics, config field names and effective non-secret values — never a signing secret). */
export function formatReport(report: DoctorReport, opts: { json: boolean }): string {
  if (opts.json) return JSON.stringify(report, null, 2);
  const lines: string[] = [];
  formatDb(report.db, lines);
  formatConfig(report.config, lines);
  lines.push("");
  lines.push(
    report.ok ? `${MARK.ok} doctor: ready` : `${MARK.bad} doctor: problems found (see above)`,
  );
  return lines.join("\n");
}

function formatDb(db: DbReport | null, lines: string[]): void {
  lines.push("Database");
  if (!db) {
    lines.push(`  ${MARK.info} skipped (--skip-db)`);
    return;
  }
  if (!db.connected) {
    lines.push(`  ${MARK.bad} connection failed: ${db.error ?? "unknown"}`);
    return;
  }
  lines.push(`  ${db.coreTablesOk ? MARK.ok : MARK.bad} core tables present`);
  if (db.missingTables.length > 0) lines.push(`        missing: ${db.missingTables.join(", ")}`);
  if (db.pendingMigrations.length > 0) {
    lines.push(
      `  ${MARK.warn} pending migrations: ${db.pendingMigrations.join(", ")} — run migrate()`,
    );
  } else {
    lines.push(`  ${MARK.ok} migrations applied (${db.appliedMigrations.join(", ") || "none"})`);
  }
  if (db.missingIndexes.length > 0) {
    lines.push(`  ${MARK.warn} missing dispatch indexes: ${db.missingIndexes.join(", ")}`);
  } else {
    lines.push(`  ${MARK.ok} dispatch indexes present`);
  }
  formatQueue(db, lines);
}

function formatQueue(db: DbReport, lines: string[]): void {
  if (db.counts) {
    const c = db.counts;
    const pairs = Object.entries(c)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    lines.push(`  ${MARK.info} queue: ${pairs}`);
    if ((c.dead ?? 0) > 0) lines.push(`  ${MARK.warn} ${String(c.dead)} dead rows in the DLQ`);
  }
  if (db.oldestPendingAgeMs != null && db.oldestPendingAgeMs > 5 * 60_000) {
    const mins = Math.round(db.oldestPendingAgeMs / 60_000);
    lines.push(`  ${MARK.warn} oldest pending row is ${String(mins)}m old (dispatcher running?)`);
  }
  if (db.endpoints) {
    lines.push(
      `  ${MARK.info} endpoints: active=${String(db.endpoints.active)} disabled=${String(db.endpoints.disabled)}`,
    );
  }
}

function formatConfig(config: ConfigReport, lines: string[]): void {
  lines.push("");
  lines.push("Configuration");
  if (config.error) {
    lines.push(`  ${MARK.bad} invalid config: ${config.error}`);
    return;
  }
  if (!config.loaded) {
    lines.push(`  ${MARK.info} no --config given; showing readiness against defaults`);
  } else {
    lines.push(
      `  ${MARK.ok} config resolves; overridden: ${config.overridden.join(", ") || "none"}`,
    );
  }
  for (const item of config.checklist) {
    const mark = item.status === "warn" ? MARK.warn : item.status === "ok" ? MARK.ok : MARK.info;
    lines.push(`  ${mark} ${item.key}: ${item.detail}`);
  }
}

// --- Wiring --------------------------------------------------------------------------------------

/** Run the doctor command; returns a process exit code. */
async function runDoctor(values: {
  config?: string;
  "database-url"?: string;
  "skip-db"?: boolean;
  json?: boolean;
}): Promise<number> {
  const loaded = values.config ? await loadConfigFile(values.config) : undefined;
  const config = buildConfigReport(loaded);

  let db: DbReport | null = null;
  if (!values["skip-db"]) {
    const url = values["database-url"] ?? process.env.DATABASE_URL;
    db = url
      ? await inspectViaUrl(url)
      : dbError("no database URL: set $DATABASE_URL or --database-url, or pass --skip-db");
  }

  const report: DoctorReport = { config, db, ok: false };
  report.ok = isOk(report);
  process.stdout.write(formatReport(report, { json: values.json ?? false }) + "\n");
  return report.ok ? 0 : 1;
}

/** Parse argv and dispatch. Exported for testing; returns an exit code. */
export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        "database-url": { type: "string" },
        "skip-db": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 1;
  }
  const cmd = parsed.positionals[0];
  if (parsed.values.help || !cmd) {
    process.stdout.write(USAGE);
    return parsed.values.help ? 0 : 1; // explicit --help is success; a bare invocation is an error
  }
  if (cmd !== "doctor") {
    process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
    return 1;
  }
  return runDoctor(parsed.values);
}

// Execute only when run as the CLI entry (not when imported by tests): compare this module's URL to
// the invoked script (the canonical ESM "is main" check).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`commitcourier: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
